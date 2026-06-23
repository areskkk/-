import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  canConnectDatabase,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';
import { getLlmClient, resetLlmClientForTesting, setLlmClientForTesting } from '../src/modules/llm/llm-provider.js';
import { type LlmChatRequest } from '../src/modules/llm/llm.types.js';
import { agentToolRunner } from '../src/modules/agents/tools/tool-runner.js';

process.env.ALLOW_DEV_STUB_AUTH = 'true';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;
const actorId = '00000000-0000-0000-0000-000000000024';
const authHeader = { authorization: `Bearer dev:${actorId}:system_admin` };

describeIfDb('P5 enterprise agent production controls', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    process.env.AGENT_RUN_ASYNC_ENABLED = 'false';
    process.env.AGENT_ORCHESTRATION_ENABLED = 'false';
    process.env.AGENT_MODEL_CIRCUIT_BREAKER_ENABLED = 'true';
    process.env.AGENT_MODEL_ERROR_RATE_THRESHOLD = '0.2';
    process.env.AGENT_MODEL_CIRCUIT_BREAKER_OPEN_MS = '60000';
    process.env.AGENT_MAX_RUN_TOKENS = '50000';
    process.env.AGENT_MAX_DAILY_COST_CENTS = '50000';
    await truncateBusinessTables();
    await getRows(
      `
        INSERT INTO users (user_id, name, phone, user_type)
        VALUES ($1, 'P5 Admin', '13924000024', 'government')
      `,
      [actorId],
    );
  });

  afterEach(() => {
    resetLlmClientForTesting();
  });

  it('replays a failed run and records replay linkage plus audit', async () => {
    const app = await buildApp();
    const failed = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_failed',
        input: { message: 'replay me' },
      },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().data.status).toBe('failed');
    const failedRun = await getRows<{ run_id: string }>(
      "SELECT run_id::text FROM agent_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1",
    );

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${failedRun[0].run_id}/replay`,
      headers: authHeader,
      payload: { reason: 'operator replay' },
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.run.status).toBe('failed');
    const rows = await getRows<{ source_run_id: string; replay_run_id: string; reason: string; status: string }>(
      'SELECT source_run_id::text, replay_run_id::text, reason, status FROM agent_run_replays',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_run_id: failedRun[0].run_id,
      reason: 'operator replay',
      status: 'created',
    });
    expect(rows[0].replay_run_id).not.toBe(failedRun[0].run_id);
    const audits = await getRows<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'agent_run.replay.created'",
    );
    expect(audits).toHaveLength(1);
    await app.close();
  });

  it('marks replay failed without replay_run_id when a replay run is never created', async () => {
    const app = await buildApp();
    const source = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'source for blocked replay' },
      },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/agent-ops-controls/kill-switch',
      headers: authHeader,
      payload: {
        enabled: true,
        scope: 'run_creation',
        reason: 'block replay creation',
      },
    });

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${source.json().data.run_id}/replay`,
      headers: authHeader,
      payload: { reason: 'should not create replay run' },
    });
    expect(replay.statusCode).toBe(403);
    const rows = await getRows<{ status: string; replay_run_id: string | null }>(
      'SELECT status, replay_run_id::text FROM agent_run_replays WHERE source_run_id = $1',
      [source.json().data.run_id],
    );
    expect(rows).toEqual([{
      status: 'failed',
      replay_run_id: null,
    }]);
    const audits = await getRows<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_logs WHERE action = 'agent_run.replay.failed'",
    );
    expect(audits[0].detail).toMatchObject({
      replay_created: false,
    });
    await app.close();
  });

  it('blocks run creation with kill switch and audits operator control changes', async () => {
    const app = await buildApp();
    const enabled = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/agent-ops-controls/kill-switch',
      headers: authHeader,
      payload: {
        enabled: true,
        scope: 'run_creation',
        reason: 'maintenance',
      },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().data.enabled).toBe(true);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'blocked' },
      },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('FORBIDDEN');

    const controls = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/agent-ops-controls',
      headers: authHeader,
    });
    expect(controls.json().data.kill_switch).toMatchObject({
      enabled: true,
      scope: 'run_creation',
      reason: 'maintenance',
    });
    const audits = await getRows<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'agent_ops.kill_switch.enabled'",
    );
    expect(audits).toHaveLength(1);
    await app.close();
  });

  it('opens tool circuit after repeated failures and lets operator reset it', async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'tool circuit parent' },
      },
    });
    const context = {
      run_id: created.json().data.run_id as string,
      actor_id: actorId,
      trace_id: 'p5-tool-circuit',
      agent_type: 'retrieval_planner' as const,
      entrypoint: 'consultation' as const,
    };

    for (let index = 0; index < 5; index += 1) {
      await expect(agentToolRunner.execute(
        'rag.search',
        {},
        context,
      )).rejects.toBeTruthy();
    }
    const health = await getRows<{ circuit_open_until: string | null }>(
      "SELECT circuit_open_until::text FROM agent_tool_health WHERE tool_name = 'rag.search'",
    );
    expect(health[0].circuit_open_until).toBeTruthy();

    await expect(agentToolRunner.execute(
      'rag.search',
      { query: 'blocked by circuit' },
      context,
    )).rejects.toMatchObject({ type: 'execution_failed' });

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/agent-tools/rag.search/circuit/reset',
      headers: authHeader,
    });
    expect(reset.statusCode).toBe(200);
    const resetHealth = await getRows<{ circuit_open_until: string | null }>(
      "SELECT circuit_open_until::text FROM agent_tool_health WHERE tool_name = 'rag.search'",
    );
    expect(resetHealth[0].circuit_open_until).toBeNull();
    await app.close();
  });

  it('exposes unified cost dashboard for tokens and estimated cost', async () => {
    const app = await buildApp();
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          raw: {},
        };
      },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'cost dashboard parent' },
      },
    });
    await getLlmClient().chatCompletion({
      run_id: created.json().data.run_id,
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'cost probe' }],
      response_format: 'json_object',
    });

    const dashboard = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/agent-costs',
      headers: authHeader,
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().data.summary.total_tokens).toBeGreaterThanOrEqual(15);
    expect(dashboard.json().data.by_model[0]).toMatchObject({
      model_name: 'qwen3.6-plus',
      total_tokens: expect.any(Number),
    });
    await app.close();
  });

  it('lists and decides approval gate requests with audit trail', async () => {
    const app = await buildApp();
    const run = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'approval holder' },
      },
    });
    await getRows(
      `
        UPDATE agent_runs
        SET state = jsonb_set(
          state,
          '{control}',
          jsonb_build_object(
            'approval_requests',
            jsonb_build_array(jsonb_build_object(
              'approval_id', 'approval-p5',
              'status', 'pending',
              'side_effect_class', 'approval_required',
              'reason', 'high_risk_action',
              'requested_at', now()::text,
              'context', jsonb_build_object('risk', 'high')
            ))
          ),
          true
        )
        WHERE run_id = $1
      `,
      [run.json().data.run_id],
    );

    const approvals = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/agent-approvals?status=pending',
      headers: authHeader,
    });
    expect(approvals.statusCode).toBe(200);
    expect(approvals.json().data.items).toHaveLength(1);

    const decision = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/agent-runs/${run.json().data.run_id}/approvals/approval-p5/decision`,
      headers: authHeader,
      payload: {
        status: 'approved',
        comment: 'approved by operator',
      },
    });
    expect(decision.statusCode).toBe(200);
    const decided = await getRows<{
      status: string;
      approval_resume_status: string;
      approval_resume_required: boolean;
    }>(
      `
        SELECT
          approval.value->>'status' AS status,
          state->'control'->>'approval_resume_status' AS approval_resume_status,
          (state->'control'->>'approval_resume_required')::boolean AS approval_resume_required
        FROM agent_runs
        CROSS JOIN LATERAL jsonb_array_elements(state->'control'->'approval_requests') approval(value)
        WHERE run_id = $1
      `,
      [run.json().data.run_id],
    );
    expect(decided[0].status).toBe('approved');
    expect(decided[0].approval_resume_status).toBe('awaiting_resume');
    expect(decided[0].approval_resume_required).toBe(true);
    const audits = await getRows<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'agent_approval.approved'",
    );
    expect(audits).toHaveLength(1);
    await app.close();
  });

  it('enforces fine-grained admin permissions for ops, approvals, and metrics', async () => {
    const app = await buildApp();
    const policyAdminHeader = {
      authorization: 'Bearer dev:00000000-0000-0000-0000-000000000025:policy_admin',
    };
    const departmentLeadHeader = {
      authorization: 'Bearer dev:00000000-0000-0000-0000-000000000026:department_lead',
    };
    await getRows(
      `
        INSERT INTO users (user_id, name, phone, user_type)
        VALUES
          ('00000000-0000-0000-0000-000000000025', 'Policy Admin', '13924000025', 'government'),
          ('00000000-0000-0000-0000-000000000026', 'Department Lead', '13924000026', 'government')
      `,
    );

    const opsDenied = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/agent-ops-controls/kill-switch',
      headers: policyAdminHeader,
      payload: {
        enabled: true,
        scope: 'run_creation',
      },
    });
    expect(opsDenied.statusCode).toBe(403);

    const metricsAllowed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/agent-costs',
      headers: departmentLeadHeader,
    });
    expect(metricsAllowed.statusCode).toBe(200);

    const approvalsDenied = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/agent-approvals',
      headers: policyAdminHeader,
    });
    expect(approvalsDenied.statusCode).toBe(403);
    await app.close();
  });
});
