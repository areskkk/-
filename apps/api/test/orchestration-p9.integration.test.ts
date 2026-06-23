import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  canConnectDatabase,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';
import { agentRunService } from '../src/modules/agents/agents.service.js';
import { type AgentGraphState } from '../src/modules/agents/agents.types.js';
import {
  createWorkflowInstance,
  readWorkflow,
  registerWorkflowWait,
} from '../src/modules/agents/runtime/platform-workflow.js';
import { buildDelegationTaskGraph } from '../src/modules/agents/runtime/task-graph-planner.js';
import { saveCheckpoint } from '../src/modules/agents/runtime/checkpoint.repository.js';

process.env.ALLOW_DEV_STUB_AUTH = 'true';
process.env.AGENT_RUN_ASYNC_ENABLED = 'true';
process.env.AGENT_RUN_WORKER_AUTOSTART = 'false';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;
const actorId = '00000000-0000-0000-0000-000000000099';
const authHeader = { authorization: `Bearer dev:${actorId}:system_admin` };

describeIfDb('P9 production platform integration', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    process.env.AGENT_RUN_ASYNC_ENABLED = 'true';
    process.env.AGENT_RUN_WORKER_AUTOSTART = 'false';
    await truncateBusinessTables();
    await getRows(
      `
        INSERT INTO users (user_id, name, phone, user_type)
        VALUES ($1, 'P9 Admin', '13919000009', 'government')
      `,
      [actorId],
    );
  });

  it('persists workflow wait in run state and resumes it by resume_token', async () => {
    const app = await buildApp();
    const runId = await createWorkflowRun();
    const run = await agentRunService.getRun(runId);
    const resumeToken = readWorkflow(run.state)?.waits[0]?.resume_token;
    expect(resumeToken).toMatch(/^workflow:/);

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: authHeader,
      payload: {
        workflow_resume_token: resumeToken,
        resume_payload: {
          external_event_id: 'event-p9',
        },
      },
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().data.state.runtime.workflow.waits[0]).toMatchObject({
      status: 'resumed',
      payload: {
        external_event_id: 'event-p9',
      },
    });
    const checkpoints = await getRows<{ status: string }>(
      'SELECT status FROM langgraph_checkpoints WHERE run_id = $1 ORDER BY created_at ASC',
      [runId],
    );
    expect(checkpoints.map((row) => row.status)).toContain('workflow_wait_resumed');
    await app.close();
  });

  it('rejects runtime tool execution when tenant policy disables the tool', async () => {
    const policyId = await createPolicyForRag('tenant disabled rag policy');
    process.env.AGENT_RUN_ASYNC_ENABLED = 'false';
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'consultation',
        input: {
          question: 'tenant disabled rag policy',
          policy_id: policyId,
          runtime: {
            tenant_policy: {
              tenant_id: 'tenant-deny-rag',
              allowed_tools: [],
            },
          },
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain('cannot use tool rag.search');
    await app.close();
  });

  it('returns admin action-level replay trace for a real run', async () => {
    const app = await buildApp();
    const runId = await createWorkflowRun();
    await getRows(
      `
        INSERT INTO agent_run_steps (
          run_id,
          node_name,
          agent_type,
          status,
          input,
          output
        )
        VALUES ($1, 'p9_step', 'system', 'completed', '{"action":"test"}', '{"ok":true}')
      `,
      [runId],
    );

    const replay = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/agent-runs/${runId}/action-replay`,
      headers: authHeader,
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toMatchObject({
      version: 'action_replay.v1',
      run_id: runId,
      actions: [
        {
          kind: 'step',
          node_name: 'p9_step',
        },
      ],
    });
    await app.close();
  });

  it('exposes admin SLA escalation scan for expired workflow waits', async () => {
    const app = await buildApp();
    const runId = await createWorkflowRun('2000-01-01T00:00:00.000Z');

    const scanned = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/agent-workflows/sla-scan',
      headers: authHeader,
      payload: {
        now: '2000-01-01T00:01:00.000Z',
      },
    });

    expect(scanned.statusCode).toBe(200);
    expect(scanned.json().data.escalated).toEqual([
      expect.objectContaining({
        run_id: runId,
      }),
    ]);
    const rows = await getRows<{ state: AgentGraphState }>(
      'SELECT state FROM agent_runs WHERE run_id = $1',
      [runId],
    );
    expect(rows[0].state.runtime?.workflow?.waits).toEqual([
      expect.objectContaining({
        status: 'escalated',
      }),
    ]);
    await app.close();
  });
});

async function createWorkflowRun(
  expiresAt = '2099-01-01T00:00:00.000Z',
): Promise<string> {
  const baseState: AgentGraphState = {
    run_id: 'placeholder',
    trace_id: 'trace-p9-production',
    actor_id: actorId,
    entrypoint: 'consultation',
    input: {
      question: 'workflow wait',
    },
    errors: [],
  };
  const graph = buildDelegationTaskGraph({
    phase: 'consultation',
    goal: 'p9 workflow wait',
    subagents: ['retrieval_planner'],
    fanout_mode: 'sequential',
    include_verifier: true,
  });
  const workflowState = registerWorkflowWait({
    state: createWorkflowInstance({
      state: baseState,
      graph,
      sla: {
        timeout_minutes: 1,
        escalation_policy: 'manual_review',
      },
    }),
    task_id: 'risk_judge:verifier',
    reason: 'external_event',
    expires_at: expiresAt,
  });
  const rows = await getRows<{ run_id: string }>(
    `
      INSERT INTO agent_runs (
        actor_id,
        entrypoint,
        status,
        current_node,
        state,
        trace_id
      )
      VALUES ($1, 'consultation', 'interrupted', 'workflow_wait', $2::jsonb, 'trace-p9-production')
      RETURNING run_id::text
    `,
    [actorId, JSON.stringify(workflowState)],
  );
  const runId = rows[0].run_id;
  const state = {
    ...workflowState,
    run_id: runId,
  };
  await getRows(
    'UPDATE agent_runs SET state = $2::jsonb WHERE run_id = $1',
    [runId, JSON.stringify(state)],
  );
  await saveCheckpoint({
    run_id: runId,
    state,
    status: 'workflow_waiting',
  });
  return runId;
}

async function createPolicyForRag(content: string): Promise<string> {
  const rows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, source_name, source_url, status, version, content)
      VALUES ('P9 Policy', 'manual', 'test', 'https://example.test/p9', 'effective', 'v1', $1)
      RETURNING policy_id::text
    `,
    [content],
  );
  await getRows(
    'INSERT INTO policy_ai_whitelist (policy_id, enabled) VALUES ($1, true)',
    [rows[0].policy_id],
  );
  await getRows(
    `
      INSERT INTO policy_chunks (
        policy_id,
        chunk_order,
        title,
        section_path,
        content,
        content_hash,
        version,
        status
      )
      VALUES ($1, 1, 'P9 Policy', '正文', $2, md5($2), 'v1', 'active')
    `,
    [rows[0].policy_id, content],
  );
  return rows[0].policy_id;
}
