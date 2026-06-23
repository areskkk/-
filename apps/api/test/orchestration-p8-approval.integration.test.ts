import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  canConnectDatabase,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';
import { agentRunService } from '../src/modules/agents/agents.service.js';
import { type AgentGraphState } from '../src/modules/agents/agents.types.js';
import { buildDefaultOrchestrationContract } from '../src/modules/agents/runtime/orchestration-governance.js';
import {
  decideToolSideEffect,
  requireToolSemanticDefinition,
} from '../src/modules/agents/runtime/tool-semantic-registry.js';
import { saveCheckpoint } from '../src/modules/agents/runtime/checkpoint.repository.js';

process.env.AGENT_RUN_ASYNC_ENABLED = 'false';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;
const actorId = '00000000-0000-0000-0000-000000008801';
const approvalId = '00000000-0000-0000-0000-00000000a801';

describeIfDb('P8 approval-required tool resume closure', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    process.env.AGENT_RUN_ASYNC_ENABLED = 'false';
    await truncateBusinessTables();
    await getRows(
      `
        INSERT INTO users (user_id, name, phone, user_type)
        VALUES ($1, 'P8 Admin', '13918000008', 'government')
      `,
      [actorId],
    );
  });

  it('resumes approved pending tool approval, executes tool, and completes saga', async () => {
    const policyId = await createPolicyForRag('approved tool approval policy phrase');
    const runId = await createPendingToolApprovalRun({
      policy_id: policyId,
      approval_status: 'approved',
    });
    const run = await agentRunService.getRun(runId);

    const resumed = await agentRunService.resumeRun({
      actor: {
        actor_id: actorId,
        roles: ['system_admin'],
      },
      trace_id: 'trace-p8-approval-approved',
      run_id: run.run_id,
      body: {
        task_id: 'ignored-for-tool-approval',
        idempotency_key: 'p8-tool-approval-approved',
        resume_payload: {
          approval_id: approvalId,
        },
      },
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.current_node).toBe('runtime_call_tool');
    expect(resumed.state.runtime?.pending_tool_approval).toMatchObject({
      approval_id: approvalId,
      status: 'completed',
    });
    expect(resumed.state.runtime?.saga).toMatchObject({
      status: 'completed',
    });
    const toolCalls = await getRows<{ status: string }>(
      'SELECT status FROM agent_tool_calls WHERE run_id = $1 AND tool_name = $2',
      [runId, 'rag.search'],
    );
    expect(toolCalls).toEqual([{ status: 'completed' }]);
  });

  it('does not execute rejected pending tool approval and does not create saga', async () => {
    const policyId = await createPolicyForRag('rejected tool approval policy phrase');
    const runId = await createPendingToolApprovalRun({
      policy_id: policyId,
      approval_status: 'rejected',
    });

    const resumed = await agentRunService.resumeRun({
      actor: {
        actor_id: actorId,
        roles: ['system_admin'],
      },
      trace_id: 'trace-p8-approval-rejected',
      run_id: runId,
      body: {
        task_id: 'ignored-for-tool-approval',
        idempotency_key: 'p8-tool-approval-rejected',
        resume_payload: {
          approval_id: approvalId,
        },
      },
    });

    expect(resumed.status).toBe('interrupted');
    expect(resumed.current_node).toBe('runtime_tool_approval_rejected');
    expect(resumed.state.runtime?.pending_tool_approval).toMatchObject({
      approval_id: approvalId,
      status: 'rejected',
      rejection_reason: 'not allowed',
    });
    expect(resumed.state.runtime?.saga).toBeUndefined();
    const toolCalls = await getRows<{ count: string }>(
      'SELECT count(*)::text FROM agent_tool_calls WHERE run_id = $1',
      [runId],
    );
    expect(toolCalls[0].count).toBe('0');
  });
});

async function createPolicyForRag(content: string): Promise<string> {
  const rows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, source_name, source_url, status, version, content)
      VALUES ('P8 Tool Approval Policy', 'manual', 'test', 'https://example.test/p8', 'effective', 'v1', $1)
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
      VALUES ($1, 1, 'P8 Tool Approval Policy', '正文', $2, md5($2), 'v1', 'active')
    `,
    [rows[0].policy_id, content],
  );
  return rows[0].policy_id;
}

async function createPendingToolApprovalRun(input: {
  policy_id: string;
  approval_status: 'approved' | 'rejected';
}): Promise<string> {
  const decision = {
    ...decideToolSideEffect({
      tool_name: 'rag.search',
      contract: buildDefaultOrchestrationContract({
        phase: 'consultation',
      }),
      semantic: {
        ...requireToolSemanticDefinition('rag.search'),
        semantic_class: 'approval_required',
      },
    }),
    approval_required: true,
  };
  const state: AgentGraphState = {
    run_id: 'placeholder',
    trace_id: 'trace-p8-approval',
    actor_id: actorId,
    entrypoint: 'consultation',
    current_node: 'runtime_tool_approval',
    input: {
      question: 'approved tool approval policy phrase',
      policy_id: input.policy_id,
    },
    control: {
      approval_requests: [{
        approval_id: approvalId,
        status: input.approval_status,
        side_effect_class: 'approval_required',
        reason: 'tool rag.search requires approval',
        requested_at: new Date().toISOString(),
        decided_at: new Date().toISOString(),
        decided_by: actorId,
        comment: input.approval_status === 'rejected' ? 'not allowed' : undefined,
        context: {
          tool_name: 'rag.search',
          semantic: decision,
        },
      }],
    },
    runtime: {
      phase: 'consultation',
      active_agent: 'supervisor',
      pending_tool_approval: {
        approval_id: approvalId,
        status: input.approval_status,
        action: {
          action: 'call_tool',
          tool_name: 'rag.search',
          tool_input: {
            query: input.approval_status === 'approved'
              ? 'approved tool approval policy phrase'
              : 'rejected tool approval policy phrase',
          },
        },
        phase: 'consultation',
        agent_type: 'supervisor',
        tool_scope: {
          kind: 'consultation',
          policy_id: input.policy_id,
        },
        semantic_decision: decision,
        requested_at: new Date().toISOString(),
        decided_at: new Date().toISOString(),
        rejection_reason: input.approval_status === 'rejected' ? 'not allowed' : undefined,
      },
    },
    errors: [],
  };
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
      VALUES ($1, 'consultation', 'interrupted', 'runtime_tool_approval', $2::jsonb, 'trace-p8-approval')
      RETURNING run_id::text
    `,
    [actorId, JSON.stringify(state)],
  );
  const runId = rows[0].run_id;
  const runState = {
    ...state,
    run_id: runId,
  };
  await getRows(
    'UPDATE agent_runs SET state = $2::jsonb WHERE run_id = $1',
    [runId, JSON.stringify(runState)],
  );
  await saveCheckpoint({
    run_id: runId,
    state: runState,
    status: 'interrupted',
  });
  return runId;
}
