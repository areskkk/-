import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  canConnectDatabase,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';
import { drainAgentWorkerUntilIdle } from './agent-test-utils.js';
import {
  getLlmClient,
  resetLlmClientForTesting,
  setLlmClientForTesting,
} from '../src/modules/llm/llm-provider.js';
import { LlmError, type LlmChatRequest } from '../src/modules/llm/llm.types.js';
import { wrapUntrustedContent } from '../src/modules/agents/runtime/agent-security.js';
import { runWithAgentLease } from '../src/modules/agents/runtime/agent-lease-context.js';
import { agentStepRecorder } from '../src/modules/agents/runtime/step-recorder.js';
import { saveCheckpoint } from '../src/modules/agents/runtime/checkpoint.repository.js';
import { fallbackService } from '../src/modules/fallback/fallback.service.js';
import { attachFallbackTaskToRun } from '../src/modules/agents/agents.repository.js';

process.env.ALLOW_DEV_STUB_AUTH = 'true';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;
const actorId = '00000000-0000-0000-0000-000000000022';
const authHeader = { authorization: `Bearer dev:${actorId}:system_admin` };

describeIfDb('batch22 agent runtime production controls', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    process.env.AGENT_RUN_ASYNC_ENABLED = 'true';
    process.env.AGENT_RUN_WORKER_AUTOSTART = 'false';
    process.env.AGENT_RUN_STALE_RUNNING_MS = String(15 * 60 * 1000);
    process.env.AGENT_RATE_LIMIT_PER_USER_PER_DAY = '50';
    process.env.AGENT_MAX_CONCURRENT_RUNS_PER_USER = '3';
    process.env.AGENT_MAX_CONCURRENT_RUNS_GLOBAL = '50';
    process.env.AGENT_MAX_DAILY_COST_CENTS = '50000';
    process.env.AGENT_LLM_ESTIMATED_MAX_TOKENS = '4096';
    process.env.AGENT_FALLBACK_MODEL_DEFAULT = '';
    process.env.AGENT_MODEL_CIRCUIT_BREAKER_ENABLED = 'true';
    process.env.AGENT_MODEL_CIRCUIT_BREAKER_OPEN_MS = '60000';
    await truncateBusinessTables();
    await getRows(
      `
        INSERT INTO users (user_id, name, phone, user_type)
        VALUES ($1, 'Batch22 Admin', '13922000022', 'government')
      `,
      [actorId],
    );
  });

  afterEach(() => {
    resetLlmClientForTesting();
  });

  it('returns queued immediately and lets worker complete the run asynchronously', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'queued runtime' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('queued');
    expect(response.json().data.poll_url).toBe(`/api/v1/agent-runs/${response.json().data.run_id}`);
    expect(response.json().data.state.final).toBeUndefined();

    const jobRows = await getRows<{ status: string; job_type: string }>(
      'SELECT status, job_type FROM agent_run_jobs WHERE run_id = $1',
      [response.json().data.run_id],
    );
    expect(jobRows).toEqual([{ status: 'queued', job_type: 'start' }]);

    await drainAgentWorkerUntilIdle();
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${response.json().data.run_id}`,
      headers: authHeader,
    });
    expect(detail.json().data.status).toBe('completed');
    expect(detail.json().data.state.final.answer).toBe('mock graph completed');
    await app.close();
  });

  it('blocks new runs when user concurrency limit is exhausted', async () => {
    process.env.AGENT_MAX_CONCURRENT_RUNS_PER_USER = '1';
    const app = await buildApp();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'first queued' },
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'second queued' },
      },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('RATE_LIMITED');
    await app.close();
  });

  it('atomically reserves user concurrency under parallel requests', async () => {
    process.env.AGENT_MAX_CONCURRENT_RUNS_PER_USER = '1';
    const app = await buildApp();

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => app.inject({
        method: 'POST',
        url: '/api/v1/agent-runs',
        headers: authHeader,
        payload: {
          entrypoint: 'mock_completed',
          input: { message: `parallel-${index}` },
        },
      })),
    );
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(9);
    const reservations = await getRows<{ count: string }>(
      "SELECT count(*)::text FROM agent_quota_reservations WHERE status = 'active'",
    );
    expect(Number(reservations[0].count)).toBe(1);
    await app.close();
  });

  it('atomically reserves global concurrency across different actors', async () => {
    process.env.AGENT_MAX_CONCURRENT_RUNS_PER_USER = '50';
    process.env.AGENT_MAX_CONCURRENT_RUNS_GLOBAL = '1';
    const app = await buildApp();
    const actorIds = Array.from({ length: 10 }, (_, index) =>
      `00000000-0000-0000-0000-0000000001${String(index).padStart(2, '0')}`,
    );
    await getRows(
      `
        INSERT INTO users (user_id, name, phone, user_type)
        SELECT actor_id::uuid, 'Global Actor', '13922000100', 'government'
        FROM unnest($1::text[]) AS actor_id
        ON CONFLICT (user_id) DO NOTHING
      `,
      [actorIds],
    );

    const responses = await Promise.all(
      actorIds.map((id, index) => app.inject({
        method: 'POST',
        url: '/api/v1/agent-runs',
        headers: { authorization: `Bearer dev:${id}:system_admin` },
        payload: {
          entrypoint: 'mock_completed',
          input: { message: `global-parallel-${index}` },
        },
      })),
    );
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(9);
    const reservations = await getRows<{ count: string }>(
      "SELECT count(*)::text FROM agent_quota_reservations WHERE status = 'active'",
    );
    expect(Number(reservations[0].count)).toBe(1);
    await app.close();
  });

  it('fails stale running jobs instead of replaying side-effectful graphs', async () => {
    process.env.AGENT_RUN_STALE_RUNNING_MS = '1';
    const app = await buildApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'stale worker lease' },
      },
    });
    const runId = created.json().data.run_id as string;
    const quotaBefore = await getRows<{ count: string }>(
      "SELECT count(*)::text FROM agent_quota_reservations WHERE run_id = $1 AND status = 'active'",
      [runId],
    );
    expect(Number(quotaBefore[0].count)).toBe(1);
    await getRows(
      `
        UPDATE agent_runs
        SET status = 'running', current_node = 'mock_completed'
        WHERE run_id = $1
      `,
      [runId],
    );
    await getRows(
      `
        UPDATE agent_run_jobs
        SET
          status = 'running',
          attempt_count = max_attempts,
          locked_by = 'dead-worker',
          locked_at = now() - interval '1 hour'
        WHERE run_id = $1
      `,
      [runId],
    );

    await drainAgentWorkerUntilIdle();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    expect(detail.json().data.status).toBe('failed');
    expect(detail.json().data.error_message).toBe('agent run worker lease expired before completion');

    const jobRows = await getRows<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM agent_run_jobs WHERE run_id = $1',
      [runId],
    );
    expect(jobRows).toEqual([{ status: 'failed', last_error: 'worker lease expired' }]);
    const stepRows = await getRows<{ node_name: string; status: string }>(
      `
        SELECT node_name, status
        FROM agent_run_steps
        WHERE run_id = $1
          AND node_name = 'agent_run_failed'
      `,
      [runId],
    );
    expect(stepRows).toEqual([]);
    const quotaAfter = await getRows<{ count: string }>(
      "SELECT count(*)::text FROM agent_quota_reservations WHERE run_id = $1 AND status = 'active'",
      [runId],
    );
    expect(Number(quotaAfter[0].count)).toBe(0);
    await app.close();
  });

  it('rejects stale worker side effects after another worker takes the lease', async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'lease identity guard' },
      },
    });
    const runId = created.json().data.run_id as string;
    const jobRows = await getRows<{ job_id: string }>(
      'SELECT job_id::text FROM agent_run_jobs WHERE run_id = $1',
      [runId],
    );
    const jobId = jobRows[0].job_id;
    await getRows(
      `
        UPDATE agent_run_jobs
        SET status = 'running',
            locked_by = 'worker-a',
            locked_at = now(),
            heartbeat_at = now()
        WHERE job_id = $1
      `,
      [jobId],
    );
    await getRows(
      `
        UPDATE agent_runs
        SET status = 'running',
            state = jsonb_set(
              jsonb_set(state, '{runtime,job_id}', to_jsonb($2::text), true),
              '{runtime,worker_id}',
              to_jsonb('worker-a'::text),
              true
            )
        WHERE run_id = $1
      `,
      [runId, jobId],
    );

    await getRows(
      `
        UPDATE agent_run_jobs
        SET locked_by = 'worker-b',
            heartbeat_at = now()
        WHERE job_id = $1
      `,
      [jobId],
    );
    await getRows(
      `
        UPDATE agent_runs
        SET state = jsonb_set(state, '{runtime,worker_id}', to_jsonb('worker-b'::text), true)
        WHERE run_id = $1
      `,
      [runId],
    );

    await expect(runWithAgentLease({
      job_id: jobId,
      worker_id: 'worker-a',
    }, async () => agentStepRecorder.recordStep({
      run_id: runId,
      node_name: 'stale_step',
      agent_type: 'test',
      status: 'completed',
      input: {},
      output: {},
    }))).rejects.toThrow('agent run worker lease lost before step write');

    await expect(runWithAgentLease({
      job_id: jobId,
      worker_id: 'worker-a',
    }, async () => saveCheckpoint({
      run_id: runId,
      state: {
        run_id: runId,
        trace_id: 'stale-checkpoint',
        actor_id: actorId,
        entrypoint: 'mock_completed',
        input: {},
        errors: [],
      },
    }))).rejects.toThrow('agent run worker lease lost before checkpoint write');

    await expect(runWithAgentLease({
      job_id: jobId,
      worker_id: 'worker-a',
    }, async () => fallbackService.createIfNotExists({
      actor_id: actorId,
      trace_id: 'stale-fallback',
      source_type: 'agent_run',
      source_id: runId,
      run_id: runId,
      reason: 'stale_worker_fallback',
      context: { run_id: runId },
    }))).rejects.toThrow('agent run worker lease lost before fallback task creation');

    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          raw: {},
        };
      },
    });
    await expect(runWithAgentLease({
      job_id: jobId,
      worker_id: 'worker-a',
    }, async () => getLlmClient().chatCompletion({
      model: 'lease-identity-model',
      run_id: runId,
      messages: [{ role: 'user', content: 'probe' }],
      response_format: 'json_object',
    }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const stepCount = await getRows<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent_run_steps WHERE run_id = $1 AND node_name = 'stale_step'`,
      [runId],
    );
    const checkpointCount = await getRows<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM langgraph_checkpoints WHERE run_id = $1 AND status = 'active'`,
      [runId],
    );
    const fallbackCount = await getRows<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM fallback_tasks WHERE source_id = $1 AND reason = 'stale_worker_fallback'`,
      [runId],
    );
    expect(stepCount[0].count).toBe('0');
    expect(checkpointCount[0].count).toBe('0');
    expect(fallbackCount[0].count).toBe('0');
    await app.close();
  });

  it('rejects stale worker fallback attach after another worker takes the lease', async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_interrupted',
        input: { message: 'fallback attach lease identity guard' },
      },
    });
    const runId = created.json().data.run_id as string;
    const jobRows = await getRows<{ job_id: string }>(
      'SELECT job_id::text FROM agent_run_jobs WHERE run_id = $1',
      [runId],
    );
    const jobId = jobRows[0].job_id;
    await getRows(
      `
        UPDATE agent_run_jobs
        SET status = 'running',
            locked_by = 'worker-a',
            locked_at = now(),
            heartbeat_at = now()
        WHERE job_id = $1
      `,
      [jobId],
    );
    await getRows(
      `
        UPDATE agent_runs
        SET status = 'running',
            state = jsonb_set(
              jsonb_set(state, '{runtime,job_id}', to_jsonb($2::text), true),
              '{runtime,worker_id}',
              to_jsonb('worker-a'::text),
              true
            )
        WHERE run_id = $1
      `,
      [runId, jobId],
    );

    const fallback = await runWithAgentLease({
      job_id: jobId,
      worker_id: 'worker-a',
    }, async () => fallbackService.createIfNotExists({
      actor_id: actorId,
      trace_id: 'stale-attach',
      source_type: 'agent_run',
      source_id: runId,
      run_id: runId,
      reason: 'stale_worker_attach',
      context: { run_id: runId },
    }));
    expect(fallback.task.run_id).toBeNull();

    await getRows(
      `
        UPDATE agent_run_jobs
        SET locked_by = 'worker-b',
            heartbeat_at = now()
        WHERE job_id = $1
      `,
      [jobId],
    );
    await getRows(
      `
        UPDATE agent_runs
        SET state = jsonb_set(state, '{runtime,worker_id}', to_jsonb('worker-b'::text), true)
        WHERE run_id = $1
      `,
      [runId],
    );

    await expect(runWithAgentLease({
      job_id: jobId,
      worker_id: 'worker-a',
    }, async () => {
      await attachFallbackTaskToRun({
        task_id: fallback.task.task_id,
        run_id: runId,
      });
      await saveCheckpoint({
        run_id: runId,
        state: {
          run_id: runId,
          trace_id: 'stale-attach-checkpoint',
          actor_id: actorId,
          entrypoint: 'mock_interrupted',
          input: {},
          errors: [],
        },
        status: 'interrupted',
      });
    })).rejects.toThrow('agent run worker lease lost before fallback task attach');

    const attached = await getRows<{ run_id: string | null }>(
      'SELECT run_id::text FROM fallback_tasks WHERE task_id = $1',
      [fallback.task.task_id],
    );
    expect(attached[0].run_id).toBeNull();
    const checkpoints = await getRows<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM langgraph_checkpoints
        WHERE run_id = $1
          AND status = 'interrupted'
          AND state->>'trace_id' = 'stale-attach-checkpoint'
      `,
      [runId],
    );
    expect(checkpoints[0].count).toBe('0');
    await getRows(
      `
        UPDATE agent_run_jobs
        SET status = 'cancelled',
            locked_by = NULL
        WHERE job_id = $1
      `,
      [jobId],
    );
    await getRows(
      `
        UPDATE agent_runs
        SET status = 'cancelled',
            state = state #- '{runtime}'
        WHERE run_id = $1
      `,
      [runId],
    );
    await app.close();
  });

  it('uses resume idempotency to avoid repeated side effects', async () => {
    const app = await buildApp();
    const interrupted = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_interrupted',
        input: { message: 'needs resume' },
      },
    });
    await drainAgentWorkerUntilIdle();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${interrupted.json().data.run_id}`,
      headers: authHeader,
    });
    const taskId = detail.json().data.state.fallback.task_id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${taskId}/resolve`,
      headers: authHeader,
      payload: {
        resolution_type: 'answer',
        resolved_payload: { manual_decision: 'confirmed' },
        comment: 'done',
      },
    });

    const resume = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${interrupted.json().data.run_id}/resume`,
      headers: authHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'resume-once',
        resume_payload: { manual_decision: 'confirmed' },
      },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().data.status).toBe('resuming');
    await drainAgentWorkerUntilIdle();

    const repeat = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${interrupted.json().data.run_id}/resume`,
      headers: authHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'resume-once',
        resume_payload: { manual_decision: 'confirmed' },
      },
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().data.run_id).toBe(interrupted.json().data.run_id);
    expect(repeat.json().data.status).toBe('completed');

    const resumeRows = await getRows<{ status: string }>(
      'SELECT status FROM agent_resume_requests WHERE run_id = $1',
      [interrupted.json().data.run_id],
    );
    expect(resumeRows).toEqual([{ status: 'completed' }]);
    await app.close();
  });

  it('executes queued resume jobs in the worker', async () => {
    const app = await buildApp();
    const interrupted = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_interrupted',
        input: { message: 'async resume worker' },
      },
    });
    await drainAgentWorkerUntilIdle();
    const runId = interrupted.json().data.run_id as string;
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    const taskId = detail.json().data.state.fallback.task_id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${taskId}/resolve`,
      headers: authHeader,
      payload: {
        resolution_type: 'answer',
        resolved_payload: { manual_decision: 'confirmed from fallback' },
        comment: 'resolved',
      },
    });

    const resume = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: authHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'async-resume-worker',
      },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().data.status).toBe('resuming');

    const jobs = await getRows<{ job_type: string; status: string; payload: Record<string, unknown> }>(
      'SELECT job_type, status, payload FROM agent_run_jobs WHERE run_id = $1 ORDER BY created_at',
      [runId],
    );
    expect(jobs.some((job) => job.job_type === 'resume' && job.status === 'queued')).toBe(true);
    await drainAgentWorkerUntilIdle();

    const completed = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    expect(completed.json().data.status).toBe('completed');
    expect(completed.json().data.state.final.answer).toBe('mock graph resumed');
    expect(completed.json().data.state.fallback.resume_payload.manual_decision)
      .toBe('confirmed from fallback');
    await app.close();
  });

  it('rejects concurrent resume requests for the same task with business 409', async () => {
    const app = await buildApp();
    const interrupted = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_interrupted',
        input: { message: 'concurrent resume' },
      },
    });
    await drainAgentWorkerUntilIdle();
    const runId = interrupted.json().data.run_id as string;
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    const taskId = detail.json().data.state.fallback.task_id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${taskId}/resolve`,
      headers: authHeader,
      payload: {
        resolution_type: 'answer',
        resolved_payload: { manual_decision: 'confirmed' },
        comment: 'resolved',
      },
    });

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/agent-runs/${runId}/resume`,
        headers: authHeader,
        payload: { task_id: taskId, idempotency_key: 'resume-a' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/agent-runs/${runId}/resume`,
        headers: authHeader,
        payload: { task_id: taskId, idempotency_key: 'resume-b' },
      }),
    ]);

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    const conflict = responses.find((response) => response.statusCode === 409);
    expect(conflict?.json().error.message).toBe('resume request is already running');
    await app.close();
  });

  it('does not reclaim stale resume jobs after max attempts are exhausted', async () => {
    process.env.AGENT_RUN_STALE_RUNNING_MS = '1';
    const app = await buildApp();
    const interrupted = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_interrupted',
        input: { message: 'stale resume max attempts' },
      },
    });
    await drainAgentWorkerUntilIdle();
    const runId = interrupted.json().data.run_id as string;
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    const taskId = detail.json().data.state.fallback.task_id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${taskId}/resolve`,
      headers: authHeader,
      payload: {
        resolution_type: 'answer',
        resolved_payload: { manual_decision: 'confirmed' },
        comment: 'resolved',
      },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: authHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'resume-stale-max',
      },
    });
    await getRows(
      `
        UPDATE agent_run_jobs
        SET
          status = 'running',
          attempt_count = max_attempts,
          locked_by = 'dead-worker',
          locked_at = now() - interval '1 hour'
        WHERE run_id = $1
          AND job_type = 'resume'
      `,
      [runId],
    );

    await drainAgentWorkerUntilIdle();

    const jobRows = await getRows<{ status: string; attempt_count: number }>(
      'SELECT status, attempt_count FROM agent_run_jobs WHERE run_id = $1 AND job_type = $2',
      [runId, 'resume'],
    );
    expect(jobRows).toEqual([{ status: 'failed', attempt_count: 2 }]);
    await app.close();
  });

  it('does not let terminal failed runs be overwritten as completed', async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'terminal guard' },
      },
    });
    const runId = created.json().data.run_id as string;
    await getRows(
      `
        UPDATE agent_runs
        SET status = 'failed', current_node = 'forced_failed'
        WHERE run_id = $1
      `,
      [runId],
    );

    await drainAgentWorkerUntilIdle();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    expect(detail.json().data.status).toBe('failed');
    expect(detail.json().data.current_node).toBe('forced_failed');
    await app.close();
  });

  it('retries a transient thrown start job instead of treating it as lease expiry', async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'throw-on-first-attempt' },
      },
    });
    const runId = created.json().data.run_id as string;
    await drainAgentWorkerUntilIdle();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    expect(detail.json().data.status).toBe('completed');
    expect(detail.json().data.state.runtime.retry_probe_failed).toBe(true);
    const jobRows = await getRows<{ status: string; attempt_count: number; last_error: string | null }>(
      'SELECT status, attempt_count, last_error FROM agent_run_jobs WHERE run_id = $1',
      [runId],
    );
    expect(jobRows).toEqual([{
      status: 'completed',
      attempt_count: 2,
      last_error: 'agent run failed',
    }]);
    await app.close();
  });

  it('opens model circuit on rate limits and blocks repeated provider calls', async () => {
    let providerCalls = 0;
    setLlmClientForTesting({
      async chatCompletion(request: LlmChatRequest) {
        providerCalls += 1;
        throw new LlmError({
          type: 'rate_limit',
          message: 'fake model rate limited',
          retryable: true,
          provider: 'fake',
          model: request.model,
          trace_id: request.trace_id,
        });
      },
    });

    await expect(getLlmClient().chatCompletion({
      model: 'qwen-plus-2025-07-28',
      messages: [{ role: 'user', content: 'trigger rate limit' }],
      response_format: 'json_object',
    })).rejects.toMatchObject({ type: 'rate_limit' });

    const healthRows = await getRows<{ circuit_open_until: string | null }>(
      `
        SELECT circuit_open_until::text
        FROM agent_model_health
        WHERE model_name = $1
      `,
      ['qwen-plus-2025-07-28'],
    );
    expect(healthRows[0]?.circuit_open_until).toBeTruthy();

    await expect(getLlmClient().chatCompletion({
      model: 'qwen-plus-2025-07-28',
      messages: [{ role: 'user', content: 'blocked by circuit' }],
      response_format: 'json_object',
    })).rejects.toMatchObject({
      type: 'local_circuit_open',
      message: 'model circuit breaker is open',
    });
    expect(providerCalls).toBe(1);
  });

  it('uses configured fallback model when primary model circuit is open', async () => {
    process.env.AGENT_FALLBACK_MODEL_DEFAULT = 'fallback-model';
    await getRows(
      `
        INSERT INTO agent_model_health (model_name, circuit_open_until)
        VALUES ('primary-open-model', now() + interval '1 hour')
        ON CONFLICT (model_name) DO UPDATE
        SET circuit_open_until = EXCLUDED.circuit_open_until
      `,
    );
    let usedModel = '';
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        usedModel = request.model;
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          raw: {},
        };
      },
    });

    await getLlmClient().chatCompletion({
      model: 'primary-open-model',
      messages: [{ role: 'user', content: 'probe' }],
      response_format: 'json_object',
    });
    expect(usedModel).toBe('fallback-model');
  });

  it('uses fallback model in the real graph path when primary circuit is open', async () => {
    process.env.AGENT_RUN_ASYNC_ENABLED = 'false';
    process.env.AGENT_FALLBACK_MODEL_DEFAULT = 'fallback-model';
    process.env.AGENT_MODEL_SUPERVISOR = 'primary-open-model';
    await getRows(
      `
        INSERT INTO agent_model_health (model_name, circuit_open_until)
        VALUES ('primary-open-model', now() + interval '1 hour')
        ON CONFLICT (model_name) DO UPDATE
        SET circuit_open_until = EXCLUDED.circuit_open_until
      `,
    );
    const usedModels: string[] = [];
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        usedModels.push(request.model);
        return {
          provider: 'fake',
          model: request.model,
          content: '{"intent_type":"policy_qa","confidence":0.9,"missing_fields":[],"next_node":"retrieval_planner"}',
          json: {
            intent_type: 'policy_qa',
            confidence: 0.9,
            missing_fields: [],
            next_node: 'retrieval_planner',
          } as TJson,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          raw: {},
        };
      },
    });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'consultation',
        input: { question: '政策咨询 fallback model probe' },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(usedModels[0]).toBe('fallback-model');
    await app.close();
  });

  it('blocks a second llm call before exceeding run budget and records model-priced cost', async () => {
    process.env.AGENT_MAX_RUN_TOKENS = '13';
    process.env.AGENT_LLM_ESTIMATED_MAX_TOKENS = '6';
    const app = await buildApp();
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
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
        input: { message: 'budget parent' },
      },
    });
    const runId = created.json().data.run_id as string;
    await getLlmClient().chatCompletion({
      run_id: runId,
      model: 'qwen3-vl-235b-a22b-thinking',
      messages: [{ role: 'user', content: 'first' }],
      response_format: 'json_object',
    });
    await expect(getLlmClient().chatCompletion({
      run_id: runId,
      model: 'qwen3-vl-235b-a22b-thinking',
      messages: [{ role: 'user', content: 'second' }],
      response_format: 'json_object',
    })).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const calls = await getRows<{ estimated_cost_cents: string }>(
      `
        SELECT estimated_cost_cents::text
        FROM agent_llm_calls
        WHERE run_id = $1
          AND status = 'completed'
      `,
      [runId],
    );
    expect(Number(calls[0].estimated_cost_cents)).toBeGreaterThan(0);
    const audits = await getRows<{ action: string; detail: Record<string, unknown> }>(
      `
        SELECT action, detail
        FROM audit_logs
        WHERE action = 'llm.chat.completed'
          AND detail->>'run_id' = $1
      `,
      [runId],
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0].detail)).not.toContain('first');
    await app.close();
  });

  it('uses prompt plus completion projection for run token budget and records blocked calls', async () => {
    process.env.AGENT_MAX_RUN_TOKENS = '10';
    process.env.AGENT_LLM_ESTIMATED_MAX_TOKENS = '6';
    const app = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'blocked budget parent' },
      },
    });
    const runId = created.json().data.run_id as string;

    await expect(getLlmClient().chatCompletion({
      run_id: runId,
      model: 'qwen3-vl-235b-a22b-thinking',
      messages: [{ role: 'user', content: 'blocked-before-provider' }],
      response_format: 'json_object',
    })).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const calls = await getRows<{ status: string; error_type: string }>(
      'SELECT status, error_type FROM agent_llm_calls WHERE run_id = $1',
      [runId],
    );
    expect(calls).toEqual([{ status: 'blocked', error_type: 'RATE_LIMITED' }]);
    await app.close();
  });

  it('does not fail successful provider calls when llm audit persistence fails', async () => {
    process.env.AGENT_MAX_RUN_TOKENS = '50000';
    const app = await buildApp();
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
        input: { message: 'audit persistence parent' },
      },
    });
    try {
      await getRows(
        `
          ALTER TABLE agent_llm_calls
          ADD CONSTRAINT test_agent_llm_calls_insert_fail CHECK (false) NOT VALID
        `,
      );
      const response = await getLlmClient().chatCompletion<{ ok: boolean }>({
        run_id: created.json().data.run_id,
        model: 'qwen3-vl-235b-a22b-thinking',
        messages: [{ role: 'user', content: 'provider succeeds' }],
        response_format: 'json_object',
      });
      expect(response.json).toEqual({ ok: true });
    } finally {
      await getRows('ALTER TABLE agent_llm_calls DROP CONSTRAINT IF EXISTS test_agent_llm_calls_insert_fail');
    }
    await app.close();
  });

  it('does not fail successful provider calls when model health persistence fails', async () => {
    process.env.AGENT_MAX_RUN_TOKENS = '50000';
    const app = await buildApp();
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          raw: {},
        };
      },
    });
    try {
      await getRows(
        `
          ALTER TABLE agent_model_health
          ADD CONSTRAINT test_agent_model_health_insert_fail CHECK (false) NOT VALID
        `,
      );
      const response = await getLlmClient().chatCompletion<{ ok: boolean }>({
        model: 'qwen3-vl-235b-a22b-thinking',
        messages: [{ role: 'user', content: 'provider succeeds despite health failure' }],
        response_format: 'json_object',
      });
      expect(response.json).toEqual({ ok: true });
    } finally {
      await getRows('ALTER TABLE agent_model_health DROP CONSTRAINT IF EXISTS test_agent_model_health_insert_fail');
    }
    await app.close();
  });

  it('audits daily budget overrun when settlement actual cost first crosses the limit', async () => {
    process.env.AGENT_MAX_DAILY_COST_CENTS = '100';
    process.env.AGENT_MAX_RUN_COST_CENTS = '10000';
    process.env.AGENT_LLM_ESTIMATED_MAX_TOKENS = '1';
    const app = await buildApp();
    await getRows(
      `
        INSERT INTO agent_model_prices (model_name, input_cents_per_1k, output_cents_per_1k)
        VALUES ('overrun-actual-model', 10, 10)
        ON CONFLICT (model_name) DO UPDATE
        SET input_cents_per_1k = EXCLUDED.input_cents_per_1k,
            output_cents_per_1k = EXCLUDED.output_cents_per_1k
      `,
    );
    await getRows(
      `
        INSERT INTO agent_daily_budget_reservations (
          trace_id,
          model_name,
          reserved_tokens,
          reserved_cost_cents,
          actual_tokens,
          actual_cost_cents,
          status,
          settled_at
        )
        VALUES (
          'daily-budget-existing',
          'overrun-actual-model',
          1,
          1,
          9500,
          95,
          'settled',
          now()
        )
      `,
    );
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 500, completion_tokens: 500, total_tokens: 1000 },
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
        input: { message: 'daily budget actual overrun' },
      },
    });
    await getLlmClient().chatCompletion({
      run_id: created.json().data.run_id,
      model: 'overrun-actual-model',
      messages: [{ role: 'user', content: 'cross actual daily budget' }],
      response_format: 'json_object',
      estimated_max_tokens: 1,
    });

    const audits = await getRows<{ count: string }>(
      "SELECT count(*)::text FROM audit_logs WHERE action = 'llm.daily_budget.overrun'",
    );
    expect(Number(audits[0].count)).toBe(1);
    const metrics = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/agent-metrics',
      headers: authHeader,
    });
    expect(metrics.json().data.alerts.daily_budget_overrun.status).toBe('firing');
    await app.close();
  });

  it('pre-reserves daily llm cost budget atomically under parallel calls', async () => {
    process.env.AGENT_MAX_DAILY_COST_CENTS = '1';
    process.env.AGENT_LLM_ESTIMATED_MAX_TOKENS = '5000';
    const app = await buildApp();
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
        input: { message: 'daily budget parent' },
      },
    });
    const runId = created.json().data.run_id as string;

    const calls = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) => getLlmClient().chatCompletion({
        run_id: runId,
        model: 'qwen3-vl-235b-a22b-thinking',
        messages: [{ role: 'user', content: `parallel-budget-${index}` }],
        response_format: 'json_object',
      })),
    );
    expect(calls.filter((call) => call.status === 'rejected')).toHaveLength(5);
    const reservations = await getRows<{ count: string }>(
      `
        SELECT count(*)::text
        FROM agent_daily_budget_reservations
        WHERE run_id = $1
          AND status = 'reserved'
      `,
      [runId],
    );
    expect(Number(reservations[0].count)).toBe(0);
    await app.close();
  });

  it('writes step and tool completion audit records', async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'audit step tool' },
      },
    });
    await drainAgentWorkerUntilIdle();
    const actions = await getRows<{ action: string }>(
      `
        SELECT action
        FROM audit_logs
        WHERE detail->>'run_id' = $1
          AND action IN ('agent_step.completed', 'agent_tool_call.completed')
        ORDER BY action
      `,
      [created.json().data.run_id],
    );
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(['agent_step.completed', 'agent_tool_call.completed']),
    );
    await app.close();
  });

  it('exposes production agent metrics for queue, model health, and fallback SLA', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/agent-metrics',
      headers: authHeader,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      queue_depth: expect.any(Object),
      run_rates: expect.any(Object),
      llm: expect.any(Object),
      fallback_sla: expect.objectContaining({
        by_reason: expect.any(Array),
      }),
      alerts: expect.objectContaining({
        daily_budget_overrun: expect.objectContaining({
          status: 'ok',
          count_24h: 0,
        }),
      }),
      model_health: expect.any(Array),
    });
    await app.close();
  });

  it('surfaces daily budget overrun audits as an operator alert', async () => {
    await getRows(
      `
        INSERT INTO audit_logs (
          actor_id,
          action,
          target_type,
          target_id,
          detail
        )
        VALUES (
          'system',
          'llm.daily_budget.overrun',
          'agent_daily_budget',
          '2026-06-09',
          '{"daily_cost_cents": 51000, "max_daily_cost_cents": 50000}'::jsonb
        )
      `,
    );
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/agent-metrics',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.alerts.daily_budget_overrun).toMatchObject({
      status: 'firing',
      count_24h: 1,
      operator_action: 'pause_non_critical_agent_runs_and_follow_budget_sla_runbook',
    });
    await app.close();
  });

  it('redacts sensitive content before llm calls', async () => {
    let content = '';
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        content = request.messages[0].content;
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          raw: {},
        };
      },
    });
    await getLlmClient().chatCompletion({
      model: 'redaction-model',
      messages: [{
        role: 'user',
        content: 'phone 13912345678 credit 913607FF0000210001 id 110101199003074219',
      }],
      response_format: 'json_object',
    });
    expect(content).not.toContain('13912345678');
    expect(content).not.toContain('913607FF0000210001');
    expect(content).not.toContain('110101199003074219');
  });

  it('redacts json secrets and escapes untrusted closing tags before llm calls', async () => {
    let content = '';
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        content = request.messages[0].content;
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          raw: {},
        };
      },
    });
    await getLlmClient().chatCompletion({
      model: 'redaction-model',
      messages: [{
        role: 'user',
        content: wrapUntrustedContent(
          'json_secret_probe',
          { token: 'abcd12345678', nested: { api_key: 'sk-test-secret' }, text: '</untrusted_content>' },
        ),
      }],
      response_format: 'json_object',
    });
    expect(content).not.toContain('abcd12345678');
    expect(content).not.toContain('sk-test-secret');
    expect(content).toContain('&lt;/untrusted_content&gt;');
  });

  it('audits async resume completion and stores resume_failed checkpoints consistently', async () => {
    const app = await buildApp();
    const interrupted = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: authHeader,
      payload: {
        entrypoint: 'mock_interrupted',
        input: { message: 'resume audit p1' },
      },
    });
    await drainAgentWorkerUntilIdle();
    const runId = interrupted.json().data.run_id as string;
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeader,
    });
    const taskId = detail.json().data.state.fallback.task_id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${taskId}/resolve`,
      headers: authHeader,
      payload: {
        resolution_type: 'answer',
        resolved_payload: { force_retryable_resume_error: true },
        comment: 'resolved',
      },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: authHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'resume-fails-once',
      },
    });
    await drainAgentWorkerUntilIdle();
    const checkpoints = await getRows<{ status: string }>(
      `
        SELECT status
        FROM langgraph_checkpoints
        WHERE run_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [runId],
    );
    expect(checkpoints[0].status).toBe('resume_failed');

    await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: authHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'resume-succeeds',
        resume_payload: {
          force_retryable_resume_error: false,
          manual_decision: 'confirmed',
        },
      },
    });
    await drainAgentWorkerUntilIdle();
    const audits = await getRows<{ detail: Record<string, unknown> }>(
      `
        SELECT detail
        FROM audit_logs
        WHERE action = 'agent_run.resumed'
          AND detail->>'run_id' = $1
      `,
      [runId],
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0].detail.task_id).toBe(taskId);
    expect(audits[0].detail.resume_request_id).toBeTruthy();
    await app.close();
  });

  it('resets model health counters after the rolling window expires', async () => {
    process.env.AGENT_MODEL_CIRCUIT_BREAKER_WINDOW_MS = '1';
    await getRows(
      `
        INSERT INTO agent_model_health (
          model_name,
          window_started_at,
          request_count,
          error_count,
          rate_limit_count,
          latency_samples_ms
        )
        VALUES (
          'window-reset-model',
          now() - interval '1 hour',
          10,
          10,
          0,
          '[100]'::jsonb
        )
        ON CONFLICT (model_name) DO UPDATE
        SET
          window_started_at = EXCLUDED.window_started_at,
          request_count = EXCLUDED.request_count,
          error_count = EXCLUDED.error_count,
          rate_limit_count = EXCLUDED.rate_limit_count,
          latency_samples_ms = EXCLUDED.latency_samples_ms,
          circuit_open_until = NULL
      `,
    );
    setLlmClientForTesting({
      async chatCompletion<TJson = unknown>(request: LlmChatRequest) {
        return {
          provider: 'fake',
          model: request.model,
          content: '{"ok":true}',
          json: { ok: true } as TJson,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          raw: {},
        };
      },
    });

    await getLlmClient().chatCompletion({
      model: 'window-reset-model',
      messages: [{ role: 'user', content: 'probe' }],
      response_format: 'json_object',
    });

    const rows = await getRows<{
      request_count: number;
      error_count: number;
      circuit_open_until: string | null;
    }>(
      `
        SELECT request_count, error_count, circuit_open_until::text
        FROM agent_model_health
        WHERE model_name = 'window-reset-model'
      `,
    );
    expect(rows[0]).toMatchObject({
      request_count: 1,
      error_count: 0,
      circuit_open_until: null,
    });
  });
});
