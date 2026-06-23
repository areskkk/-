import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  canConnectDatabase,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';
import { drainAgentWorkerUntilIdle, readRun } from './agent-test-utils.js';

process.env.ALLOW_DEV_STUB_AUTH = 'true';
process.env.AGENT_RUN_ASYNC_ENABLED = 'true';
process.env.AGENT_RUN_WORKER_AUTOSTART = 'false';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;
const batch17ActorId = '00000000-0000-0000-0000-000000000017';
const authHeader = { authorization: `Bearer dev:${batch17ActorId}:system_admin` };

describeIfDb('batch17 agent run runtime', () => {
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
        VALUES ($1, 'Batch17 Admin', '13917000017', 'government')
      `,
      [batch17ActorId],
    );
  });

  it('runs mock graph to completed without calling LLM and records steps, tool calls, checkpoints', async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'hello agent runtime' },
        idempotency_key: 'batch17-completed',
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json().data.status).toBe('queued');
    expect(created.json().data.poll_url).toBe(`/api/v1/agent-runs/${created.json().data.run_id}`);
    await drainAgentWorkerUntilIdle();
    const completed = await readRun(created.json().data.run_id);
    expect(completed.status).toBe('completed');
    expect(created.json().data.final).toBeUndefined();
    expect((completed.state as { final: unknown }).final).toMatchObject({
      status: 'completed',
      answer: 'mock graph completed',
    });

    const runId = created.json().data.run_id as string;
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'hello agent runtime' },
        idempotency_key: 'batch17-completed',
      },
    });
    expect(duplicate.json().data.run_id).toBe(runId);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.status).toBe('completed');

    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}/steps`,
      headers: authHeader,
    });
    expect(steps.statusCode).toBe(200);
    expect(steps.json().data.steps.map((step: { node_name: string }) => step.node_name))
      .toEqual(['mock_start', 'mock_finalize']);
    expect(steps.json().data.steps.every((step: { status: string }) => step.status === 'completed'))
      .toBe(true);
    expect(steps.json().data.tool_calls).toHaveLength(1);
    expect(steps.json().data.tool_calls[0]).toMatchObject({
      tool_name: 'mock.echo',
      status: 'completed',
    });

    const checkpointRows = await getRows<{ status: string }>(
      'SELECT status FROM langgraph_checkpoints WHERE run_id = $1 ORDER BY created_at ASC',
      [runId],
    );
    expect(checkpointRows.map((row) => row.status)).toEqual(['active', 'completed']);
    await app.close();
  });

  it('accepts cross-domain orchestration through the production run creation API', async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'cross-domain contract' },
        orchestration: {
          mode: 'cross_domain',
        },
      },
    });

    expect(created.statusCode).toBe(200);
    const rows = await getRows<{ state: Record<string, unknown> }>(
      'SELECT state FROM agent_runs WHERE run_id = $1',
      [created.json().data.run_id],
    );
    expect(rows[0].state.runtime).toMatchObject({
      orchestration_contract: {
        version: 'orchestration.v1',
        mode: 'cross_domain',
        cross_domain: {
          artifact_scope: 'target_phase_owner',
          resume_contract: 'parent_runtime_controls_child_resume',
        },
      },
    });
    await app.close();
  });

  it('resumes a nested runtime from parent run and child resume token', async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'nested resume parent' },
      },
    });
    expect(created.statusCode).toBe(200);
    await drainAgentWorkerUntilIdle();
    const runId = created.json().data.run_id as string;
    const resumeToken = `subagent:${runId}:mock_child:resume`;
    const childState = {
      run_id: runId,
      trace_id: 'nested-resume-trace',
      actor_id: batch17ActorId,
      entrypoint: 'mock_completed',
      input: { message: 'nested child checkpoint' },
      current_node: 'mock_child_completed',
      runtime: {
        nested_checkpoint: {
          parent_run_id: runId,
          runtime_id: `subagent:${runId}:mock_child`,
          task_id: 'mock_child',
          resume_token: resumeToken,
          from_phase: 'mock_completed',
          target_phase: 'mock_completed',
          agent_type: 'supervisor',
          status: 'completed',
        },
      },
      errors: [],
    };
    await getRows(
      `
        INSERT INTO langgraph_checkpoints (run_id, state, status)
        VALUES ($1, $2::jsonb, 'nested_completed')
      `,
      [runId, JSON.stringify(childState)],
    );

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: authHeader,
      payload: {
        nested_resume_token: resumeToken,
        resume_payload: {
          manual_decision: 'retry_child',
        },
      },
    });

    expect(resumed.statusCode).toBe(200);
    await drainAgentWorkerUntilIdle();
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    expect(detail.json().data.state.runtime.nested_resume).toMatchObject({
      runtime_id: `subagent:${runId}:mock_child`,
      task_id: 'mock_child',
      resume_token: resumeToken,
      target_phase: 'mock_completed',
      payload: {
        manual_decision: 'retry_child',
      },
    });
    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}/steps`,
      headers: authHeader,
    });
    expect(steps.json().data.steps.map((step: { node_name: string }) => step.node_name))
      .toContain('nested_runtime_resume');
    await app.close();
  });

  it('marks mock graph as failed and records failed step', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_failed',
        input: { message: 'fail intentionally' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('queued');
    await drainAgentWorkerUntilIdle();
    const failed = await readRun(response.json().data.run_id);
    expect(failed.status).toBe('failed');
    expect(failed.error_message).toBe('mock graph failed intentionally');
    expect((failed.state as { errors: unknown }).errors).toEqual([
      {
        node: 'mock_failed',
        message: 'mock graph failed intentionally',
      },
    ]);

    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${response.json().data.run_id}/steps`,
      headers: authHeader,
    });
    expect(steps.json().data.steps).toHaveLength(1);
    expect(steps.json().data.steps[0]).toMatchObject({
      node_name: 'mock_failed',
      status: 'failed',
      error_message: 'mock graph failed intentionally',
    });
    await app.close();
  });

  it('interrupts mock graph, links fallback task by run_id, then resumes to completed', async () => {
    const app = await buildApp();

    const interrupted = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_interrupted',
        input: { message: 'needs human' },
      },
    });

    expect(interrupted.statusCode).toBe(200);
    expect(interrupted.json().data.status).toBe('queued');
    const runId = interrupted.json().data.run_id as string;
    await drainAgentWorkerUntilIdle();
    const interruptedRun = await readRun(runId);
    expect(interruptedRun.status).toBe('interrupted');
    const taskId = ((interruptedRun.state as { fallback: { task_id: string } }).fallback.task_id);

    const fallbackRows = await getRows<{
      task_id: string;
      run_id: string;
      source_type: string;
      source_id: string;
    }>(
      `
        SELECT task_id::text, run_id, source_type, source_id
        FROM fallback_tasks
        WHERE task_id = $1
      `,
      [taskId],
    );
    expect(fallbackRows).toEqual([{
      task_id: taskId,
      run_id: runId,
      source_type: 'agent_run',
      source_id: runId,
    }]);

    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: authHeader,
      payload: {
        task_id: '',
        resume_payload: {},
      },
    });
    expect(conflict.statusCode).toBe(400);

    const pendingResume = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: authHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'batch17-pending-resume',
        resume_payload: {
          manual_decision: 'confirmed',
        },
      },
    });
    expect(pendingResume.statusCode).toBe(409);

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${taskId}/resolve`,
      headers: authHeader,
      payload: {
        resolution_type: 'answer',
        resolved_payload: {
          manual_decision: 'confirmed',
        },
        comment: 'confirmed by test reviewer',
      },
    });
    expect(resolved.statusCode).toBe(200);

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: authHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'batch17-resume',
        resume_payload: {
          manual_decision: 'confirmed',
        },
      },
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().data.status).toBe('resuming');
    await drainAgentWorkerUntilIdle();
    const resumedDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    expect(resumedDetail.json().data.status).toBe('completed');
    expect(resumedDetail.json().data.state.fallback.resume_payload).toMatchObject({
      manual_decision: 'confirmed',
    });
    expect(resumedDetail.json().data.state.final).toMatchObject({
      status: 'completed',
      answer: 'mock graph resumed',
    });

    const repeat = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: authHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'batch17-repeat-resume',
        resume_payload: {},
      },
    });
    expect(repeat.statusCode).toBe(409);

    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}/steps`,
      headers: authHeader,
    });
    expect(steps.json().data.steps.map((step: { node_name: string }) => step.node_name))
      .toEqual(['mock_interrupt', 'mock_resume']);
    await app.close();
  });

  it('rejects invalid non-runtime entrypoints', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'unknown_graph',
        input: { message: 'unknown graph is not registered' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe('invalid agent run entrypoint');
    await app.close();
  });
});
