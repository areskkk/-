import {
  query,
  queryOne,
  withTransaction,
  type DbTransaction,
} from '../../db/query.js';
import {
  type AgentGraphState,
  type AgentRunJobRow,
  type AgentRunJobType,
  type AgentRunEntrypoint,
  type AgentRunRow,
  type AgentRunStatus,
  type AgentRunStepRow,
  type AgentStepStatus,
  type AgentToolCallRow,
  type AgentToolCallStatus,
} from './agents.types.js';
import { redactSensitiveData } from './runtime/agent-security.js';
import { getCurrentAgentLease } from './runtime/agent-lease-context.js';

function agentRunSelectSql(): string {
  return `
    SELECT
      run_id::text,
      actor_id,
      entrypoint,
      status,
      current_node,
      state,
      idempotency_key,
      trace_id,
      error_message,
      started_at::text,
      interrupted_at::text,
      completed_at::text,
      updated_at::text,
      version
    FROM agent_runs
  `;
}

function agentStepSelectSql(): string {
  return `
    SELECT
      step_id::text,
      run_id::text,
      node_name,
      agent_type,
      model_name,
      prompt_template_id::text,
      status,
      input,
      output,
      tool_calls,
      token_usage,
      error_message,
      started_at::text,
      completed_at::text
    FROM agent_run_steps
  `;
}

function toolCallSelectSql(): string {
  return `
    SELECT
      tool_call_id::text,
      run_id::text,
      step_id::text,
      tool_name,
      input,
      output,
      status,
      error_message,
      started_at::text,
      completed_at::text
    FROM agent_tool_calls
  `;
}

function agentRunJobSelectSql(): string {
  return `
    SELECT
      job_id::text,
      run_id::text,
      job_type,
      status,
      priority,
      attempt_count,
      max_attempts,
      locked_by,
      locked_at::text,
      heartbeat_at::text,
      available_at::text,
      last_error,
      payload,
      created_at::text,
      updated_at::text
    FROM agent_run_jobs
  `;
}

export async function findRunByIdempotencyKey(input: {
  actor_id: string;
  entrypoint: AgentRunEntrypoint;
  idempotency_key?: string;
}): Promise<AgentRunRow | undefined> {
  if (!input.idempotency_key) {
    return undefined;
  }

  return queryOne<AgentRunRow>(
    `
      ${agentRunSelectSql()}
      WHERE actor_id = $1
        AND entrypoint = $2
        AND idempotency_key = $3
      LIMIT 1
    `,
    [input.actor_id, input.entrypoint, input.idempotency_key],
  );
}

export async function findRunByScopedIdempotencyKey(input: {
  actor_id: string;
  entrypoint: AgentRunEntrypoint;
  idempotency_key?: string;
  business_scope: Record<string, unknown>;
}): Promise<AgentRunRow | undefined> {
  const run = await findRunByIdempotencyKey(input);
  if (!run) {
    return undefined;
  }

  if (!isSameBusinessScope(run.state.input, input.business_scope)) {
    throw new Error('AGENT_IDEMPOTENCY_SCOPE_CONFLICT');
  }

  return run;
}

export async function createRun(input: {
  actor_id: string;
  entrypoint: AgentRunEntrypoint;
  trace_id: string;
  state: AgentGraphState;
  idempotency_key?: string;
  status?: AgentRunStatus;
}): Promise<AgentRunRow> {
  return queryOne<AgentRunRow>(
    `
      INSERT INTO agent_runs (
        actor_id,
        entrypoint,
        trace_id,
        state,
        idempotency_key,
        current_node,
        status
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
      RETURNING
        run_id::text,
        actor_id,
        entrypoint,
        status,
        current_node,
        state,
        idempotency_key,
        trace_id,
        error_message,
        started_at::text,
        interrupted_at::text,
        completed_at::text,
        updated_at::text,
        version
    `,
    [
      input.actor_id,
      input.entrypoint,
      input.trace_id,
      JSON.stringify(input.state),
      input.idempotency_key ?? null,
      input.state.entrypoint,
      input.status ?? 'running',
    ],
  ) as Promise<AgentRunRow>;
}

export async function createQueuedRunWithJob(input: {
  actor_id: string;
  entrypoint: AgentRunEntrypoint;
  trace_id: string;
  state: AgentGraphState;
  idempotency_key?: string;
  job_payload?: Record<string, unknown>;
  max_attempts?: number;
  enterprise_id?: string;
  max_concurrent_per_user?: number;
  max_concurrent_global?: number;
}): Promise<AgentRunRow> {
  return withTransaction(async (tx) => {
    await reserveAgentQuotaWithExecutor(tx, {
      actor_id: input.actor_id,
      enterprise_id: input.enterprise_id,
      max_concurrent_per_user: input.max_concurrent_per_user,
      max_concurrent_global: input.max_concurrent_global,
    });
    const run = await insertRun(tx, {
      actor_id: input.actor_id,
      entrypoint: input.entrypoint,
      trace_id: input.trace_id,
      state: input.state,
      idempotency_key: input.idempotency_key,
      status: 'queued',
    });
    const state = {
      ...run.state,
      run_id: run.run_id,
    };
    const initialized = await updateRunStateWithExecutor(tx, {
      run_id: run.run_id,
      status: 'queued',
      current_node: 'queued',
      state,
      expected_version: run.version,
    });
    if (!initialized) {
      throw new Error('failed to initialize agent run');
    }
    await insertRunJob(tx, {
      run_id: initialized.run_id,
      job_type: 'start',
      payload: input.job_payload ?? {},
      max_attempts: input.max_attempts,
    });
    await attachQuotaReservationToRunWithExecutor(tx, {
      actor_id: input.actor_id,
      run_id: initialized.run_id,
    });
    return initialized;
  });
}

export async function reserveAgentQuota(input: {
  actor_id: string;
  enterprise_id?: string;
  max_concurrent_per_user: number;
  max_concurrent_global: number;
}): Promise<void> {
  await withTransaction(async (tx) => {
    await reserveAgentQuotaWithExecutor(tx, input);
  });
}

export async function attachQuotaReservationToRun(input: {
  actor_id: string;
  run_id: string;
}): Promise<void> {
  await query(
    `
      UPDATE agent_quota_reservations
      SET run_id = $2
      WHERE reservation_id = (
        SELECT reservation_id
        FROM agent_quota_reservations
        WHERE actor_id = $1
          AND run_id IS NULL
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      )
    `,
    [input.actor_id, input.run_id],
  );
}

export async function releaseQuotaReservation(runId: string): Promise<void> {
  await query(
    `
      UPDATE agent_quota_reservations
      SET status = 'released', released_at = now()
      WHERE run_id = $1
        AND status = 'active'
    `,
    [runId],
  );
}

export async function findRunById(runId: string): Promise<AgentRunRow | undefined> {
  return queryOne<AgentRunRow>(
    `
      ${agentRunSelectSql()}
      WHERE run_id = $1
    `,
    [runId],
  );
}

export async function findLatestRunByReplaySource(
  sourceRunId: string,
): Promise<AgentRunRow | undefined> {
  return queryOne<AgentRunRow>(
    `
      ${agentRunSelectSql()}
      WHERE state->'input'->'replay'->>'source_run_id' = $1
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [sourceRunId],
  );
}

export async function createRunJob(input: {
  run_id: string;
  job_type: AgentRunJobType;
  payload?: Record<string, unknown>;
  priority?: number;
  max_attempts?: number;
}): Promise<AgentRunJobRow> {
  return queryOne<AgentRunJobRow>(
    `
      INSERT INTO agent_run_jobs (
        run_id,
        job_type,
        payload,
        priority,
        max_attempts
      )
      VALUES ($1, $2, $3::jsonb, $4, $5)
      RETURNING
        job_id::text,
        run_id::text,
        job_type,
        status,
        priority,
        attempt_count,
        max_attempts,
        locked_by,
        locked_at::text,
        heartbeat_at::text,
        available_at::text,
        last_error,
        payload,
        created_at::text,
        updated_at::text
    `,
    [
      input.run_id,
      input.job_type,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 100,
      input.max_attempts ?? 2,
    ],
  ) as Promise<AgentRunJobRow>;
}

export async function claimNextRunJob(input: {
  worker_id: string;
  stale_running_ms: number;
}): Promise<AgentRunJobRow | undefined> {
  return queryOne<AgentRunJobRow>(
    `
      WITH stale AS (
        UPDATE agent_run_jobs
        SET
          status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
          locked_by = NULL,
          locked_at = NULL,
          heartbeat_at = NULL,
          last_error = 'worker lease expired'
        WHERE status = 'running'
          AND COALESCE(heartbeat_at, locked_at) < now() - ($2::int * interval '1 millisecond')
        RETURNING run_id, status
      ),
      stale_failed_runs AS (
        UPDATE agent_runs runs
        SET
          status = 'failed',
          current_node = 'failed',
          error_message = 'agent run worker lease expired before completion',
          completed_at = now(),
          version = version + 1
        FROM stale
        WHERE stale.status = 'failed'
          AND runs.run_id = stale.run_id
          AND runs.status NOT IN ('completed', 'failed', 'cancelled')
        RETURNING runs.run_id, runs.actor_id, runs.trace_id, runs.entrypoint, runs.state
      ),
      stale_failed_quota AS (
        UPDATE agent_quota_reservations quota
        SET status = 'released', released_at = now()
        FROM stale_failed_runs
        WHERE quota.run_id = stale_failed_runs.run_id
          AND quota.status = 'active'
        RETURNING quota.reservation_id
      ),
      stale_failed_checkpoints AS (
        INSERT INTO langgraph_checkpoints (run_id, state, status)
        SELECT
          run_id,
          jsonb_set(
            state,
            '{errors}',
            COALESCE(state->'errors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
              'node',
              'worker_lease',
              'message',
              'agent run worker lease expired before completion'
            )),
            true
          ),
          'failed'
        FROM stale_failed_runs
        RETURNING checkpoint_id
      ),
      stale_failed_audit AS (
        INSERT INTO audit_logs (
          actor_id,
          action,
          target_type,
          target_id,
          trace_id,
          detail
        )
        SELECT
          actor_id,
          'agent_run.failed',
          'agent_run',
          run_id,
          trace_id,
          jsonb_build_object(
            'run_id',
            run_id,
            'entrypoint',
            entrypoint,
            'status',
            'failed',
            'error_type',
            'agent run worker lease expired before completion'
          )
        FROM stale_failed_runs
        RETURNING log_id
      ),
      next_job AS (
        SELECT job_id
        FROM agent_run_jobs
        WHERE status = 'queued'
          AND available_at <= now()
        ORDER BY priority ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE agent_run_jobs jobs
      SET
        status = 'running',
        locked_by = $1,
        locked_at = now(),
        heartbeat_at = now(),
        attempt_count = attempt_count + 1
      FROM next_job
      WHERE jobs.job_id = next_job.job_id
      RETURNING
        jobs.job_id::text,
        jobs.run_id::text,
        jobs.job_type,
        jobs.status,
        jobs.priority,
        jobs.attempt_count,
        jobs.max_attempts,
        jobs.locked_by,
        jobs.locked_at::text,
        jobs.heartbeat_at::text,
        jobs.available_at::text,
        jobs.last_error,
        jobs.payload,
        jobs.created_at::text,
        jobs.updated_at::text
    `,
    [input.worker_id, input.stale_running_ms],
  );
}

export async function completeRunJob(jobId: string): Promise<void> {
  await query(
    `
      UPDATE agent_run_jobs
      SET
        status = 'completed',
        locked_by = NULL,
        locked_at = NULL,
        heartbeat_at = NULL
      WHERE job_id = $1
    `,
    [jobId],
  );
}

export async function completeLeasedRunJob(input: {
  job_id: string;
  worker_id: string;
}): Promise<boolean> {
  const rows = await query<{ job_id: string }>(
    `
      UPDATE agent_run_jobs
      SET
        status = 'completed',
        locked_by = NULL,
        locked_at = NULL,
        heartbeat_at = NULL
      WHERE job_id = $1
        AND status = 'running'
        AND locked_by = $2
      RETURNING job_id::text
    `,
    [input.job_id, input.worker_id],
  );
  return rows.length > 0;
}

export async function failRunJob(input: {
  job_id: string;
  error_message: string;
}): Promise<void> {
  await query(
    `
      UPDATE agent_run_jobs
      SET
        status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
        locked_by = NULL,
        locked_at = NULL,
        heartbeat_at = NULL,
        last_error = $2,
        available_at = CASE WHEN attempt_count >= max_attempts THEN available_at ELSE now() + interval '5 seconds' END
      WHERE job_id = $1
    `,
    [input.job_id, input.error_message],
  );
}

export async function failLeasedRunJob(input: {
  job_id: string;
  worker_id: string;
  error_message: string;
  retry_delay_ms?: number;
}): Promise<AgentRunJobRow | undefined> {
  return queryOne<AgentRunJobRow>(
    `
      UPDATE agent_run_jobs
      SET
        status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
        locked_by = NULL,
        locked_at = NULL,
        heartbeat_at = NULL,
        last_error = $3,
        available_at = CASE
          WHEN attempt_count >= max_attempts THEN available_at
          ELSE now() + ($4::int * interval '1 millisecond')
        END
      WHERE job_id = $1
        AND status = 'running'
        AND locked_by = $2
      RETURNING
        job_id::text,
        run_id::text,
        job_type,
        status,
        priority,
        attempt_count,
        max_attempts,
        locked_by,
        locked_at::text,
        heartbeat_at::text,
        available_at::text,
        last_error,
        payload,
        created_at::text,
        updated_at::text
    `,
    [
      input.job_id,
      input.worker_id,
      input.error_message,
      input.retry_delay_ms ?? 5000,
    ],
  );
}

export async function failLeasedRunJobPermanently(input: {
  job_id: string;
  worker_id: string;
  error_message: string;
}): Promise<AgentRunJobRow | undefined> {
  return queryOne<AgentRunJobRow>(
    `
      UPDATE agent_run_jobs
      SET
        status = 'failed',
        locked_by = NULL,
        locked_at = NULL,
        heartbeat_at = NULL,
        last_error = $3
      WHERE job_id = $1
        AND status = 'running'
        AND locked_by = $2
      RETURNING
        job_id::text,
        run_id::text,
        job_type,
        status,
        priority,
        attempt_count,
        max_attempts,
        locked_by,
        locked_at::text,
        heartbeat_at::text,
        available_at::text,
        last_error,
        payload,
        created_at::text,
        updated_at::text
    `,
    [input.job_id, input.worker_id, input.error_message],
  );
}

export async function heartbeatRunJob(input: {
  job_id: string;
  worker_id: string;
}): Promise<boolean> {
  const rows = await query<{ job_id: string }>(
    `
      UPDATE agent_run_jobs
      SET
        locked_at = now(),
        heartbeat_at = now()
      WHERE job_id = $1
        AND status = 'running'
        AND locked_by = $2
      RETURNING job_id::text
    `,
    [input.job_id, input.worker_id],
  );
  return rows.length > 0;
}

export async function assertRunJobLease(input: {
  job_id: string;
  worker_id: string;
}): Promise<boolean> {
  const row = await queryOne<{ job_id: string }>(
    `
      SELECT job_id::text
      FROM agent_run_jobs
      WHERE job_id = $1
        AND status = 'running'
        AND locked_by = $2
      LIMIT 1
    `,
    [input.job_id, input.worker_id],
  );
  return Boolean(row);
}

export async function assertRunLeaseActiveByRunId(input: {
  run_id: string;
  job_id?: string;
  worker_id?: string;
}): Promise<boolean> {
  const row = await queryOne<{ ok: number }>(
    `
      SELECT 1 AS ok
      FROM agent_runs run_guard
      WHERE run_guard.run_id = $1
        AND (
          ($2::uuid IS NULL AND NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid IS NULL)
          OR EXISTS (
            SELECT 1
            FROM agent_run_jobs leased_job
            WHERE leased_job.job_id = COALESCE($2::uuid, NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid)
              AND leased_job.run_id = run_guard.run_id
              AND leased_job.status = 'running'
              AND leased_job.locked_by = COALESCE($3, run_guard.state->'runtime'->>'worker_id')
          )
        )
      LIMIT 1
    `,
    [input.run_id, input.job_id ?? null, input.worker_id ?? null],
  );
  return Boolean(row);
}

export async function listRecoverableRunJobs(): Promise<AgentRunJobRow[]> {
  return query<AgentRunJobRow>(
    `
      ${agentRunJobSelectSql()}
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC
    `,
  );
}

export async function updateRunState(input: {
  run_id: string;
  status: AgentRunStatus;
  current_node: string | null;
  state: AgentGraphState;
  error_message?: string | null;
  expected_version?: number;
  allow_terminal_override?: boolean;
}): Promise<AgentRunRow | undefined> {
  return updateRunStateWithExecutor({ queryOne }, input);
}

export async function updateRunStateIfLeased(input: {
  run_id: string;
  status: AgentRunStatus;
  current_node: string | null;
  state: AgentGraphState;
  error_message?: string | null;
  expected_version?: number;
  allow_terminal_override?: boolean;
  job_id?: string;
  worker_id?: string;
}): Promise<AgentRunRow | undefined> {
  return updateRunStateWithExecutor({ queryOne }, input);
}

async function updateRunStateWithExecutor(
  executor: Pick<DbTransaction, 'queryOne'>,
  input: {
    run_id: string;
    status: AgentRunStatus;
    current_node: string | null;
    state: AgentGraphState;
    error_message?: string | null;
    expected_version?: number;
    allow_terminal_override?: boolean;
    job_id?: string;
    worker_id?: string;
  },
): Promise<AgentRunRow | undefined> {
  return executor.queryOne<AgentRunRow>(
    `
      UPDATE agent_runs
      SET
        status = $2,
        current_node = $3,
        state = $4::jsonb,
        error_message = $5,
        interrupted_at = CASE WHEN $2 = 'interrupted' THEN now() ELSE interrupted_at END,
        completed_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN now() ELSE completed_at END
        , version = version + 1
      WHERE run_id = $1
        AND ($6::int IS NULL OR version = $6)
        AND (
          $7::boolean = true
          OR status NOT IN ('completed', 'failed', 'cancelled')
          OR status = $2
        )
        AND (
          $8::uuid IS NULL
          OR EXISTS (
            SELECT 1
            FROM agent_run_jobs leased_job
            WHERE leased_job.job_id = $8::uuid
              AND leased_job.run_id = agent_runs.run_id
              AND leased_job.status = 'running'
              AND leased_job.locked_by = $9
          )
        )
      RETURNING
        run_id::text,
        actor_id,
        entrypoint,
        status,
        current_node,
        state,
        idempotency_key,
        trace_id,
        error_message,
        started_at::text,
        interrupted_at::text,
        completed_at::text,
        updated_at::text,
        version
    `,
    [
      input.run_id,
      input.status,
      input.current_node,
      JSON.stringify(input.state),
      input.error_message ?? null,
      input.expected_version ?? null,
      input.allow_terminal_override ?? false,
      input.job_id ?? input.state.runtime?.job_id ?? null,
      input.worker_id ?? input.state.runtime?.worker_id ?? null,
    ],
  );
}

export async function insertStep(input: {
  run_id: string;
  job_id?: string;
  worker_id?: string;
  node_name: string;
  agent_type?: string;
  model_name?: string;
  prompt_template_id?: string | null;
  status: AgentStepStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  tool_calls?: unknown[];
  token_usage?: Record<string, unknown>;
  error_message?: string;
  completed: boolean;
}): Promise<AgentRunStepRow> {
  const step = await queryOne<AgentRunStepRow>(
    `
      INSERT INTO agent_run_steps (
        run_id,
        node_name,
        agent_type,
        model_name,
        prompt_template_id,
        status,
        input,
        output,
        tool_calls,
        token_usage,
        error_message,
        completed_at
      )
      SELECT
        $1::uuid,
        $2,
        $3,
        $4,
        $5::uuid,
        $6,
        $7::jsonb,
        $8::jsonb,
        $9::jsonb,
        $10::jsonb,
        $11,
        CASE WHEN $12 THEN now() ELSE NULL END
      FROM agent_runs run_guard
      WHERE run_guard.run_id = $1::uuid
        AND (
        ($13::uuid IS NULL AND NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid IS NULL)
        OR EXISTS (
          SELECT 1
          FROM agent_run_jobs leased_job
          WHERE leased_job.job_id = COALESCE($13::uuid, NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid)
            AND leased_job.run_id = $1::uuid
            AND leased_job.status = 'running'
            AND leased_job.locked_by = COALESCE($14, run_guard.state->'runtime'->>'worker_id')
        )
      )
      RETURNING
        step_id::text,
        run_id::text,
        node_name,
        agent_type,
        model_name,
        prompt_template_id::text,
        status,
        input,
        output,
        tool_calls,
        token_usage,
        error_message,
        started_at::text,
        completed_at::text
    `,
    [
      input.run_id,
      input.node_name,
      input.agent_type ?? null,
      input.model_name ?? null,
      input.prompt_template_id ?? null,
      input.status,
      JSON.stringify(redactSensitiveData(input.input)),
      JSON.stringify(redactSensitiveData(input.output ?? {})),
      JSON.stringify(input.tool_calls ?? []),
      JSON.stringify(input.token_usage ?? {}),
      input.error_message ?? null,
      input.completed,
      input.job_id ?? null,
      input.worker_id ?? null,
    ],
  );
  if (!step) {
    throw new Error('agent run worker lease lost before step write');
  }
  return step;
}

export async function listStepsByRunId(runId: string): Promise<AgentRunStepRow[]> {
  return query<AgentRunStepRow>(
    `
      ${agentStepSelectSql()}
      WHERE run_id = $1
      ORDER BY started_at ASC, step_id ASC
    `,
    [runId],
  );
}

export async function insertToolCall(input: {
  run_id: string;
  job_id?: string;
  worker_id?: string;
  step_id?: string;
  tool_name: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: AgentToolCallStatus;
  error_message?: string;
  completed: boolean;
}): Promise<AgentToolCallRow> {
  const toolCall = await queryOne<AgentToolCallRow>(
    `
      INSERT INTO agent_tool_calls (
        run_id,
        step_id,
        tool_name,
        input,
        output,
        status,
        error_message,
        completed_at
      )
      SELECT
        $1::uuid,
        $2::uuid,
        $3,
        $4::jsonb,
        $5::jsonb,
        $6,
        $7,
        CASE WHEN $8 THEN now() ELSE NULL END
      FROM agent_runs run_guard
      WHERE run_guard.run_id = $1::uuid
        AND (
        ($9::uuid IS NULL AND NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid IS NULL)
        OR EXISTS (
          SELECT 1
          FROM agent_run_jobs leased_job
          WHERE leased_job.job_id = COALESCE($9::uuid, NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid)
            AND leased_job.run_id = $1::uuid
            AND leased_job.status = 'running'
            AND leased_job.locked_by = COALESCE($10, run_guard.state->'runtime'->>'worker_id')
        )
      )
      RETURNING
        tool_call_id::text,
        run_id::text,
        step_id::text,
        tool_name,
        input,
        output,
        status,
        error_message,
        started_at::text,
        completed_at::text
    `,
    [
      input.run_id,
      input.step_id ?? null,
      input.tool_name,
      JSON.stringify(redactSensitiveData(input.input)),
      JSON.stringify(redactSensitiveData(input.output ?? {})),
      input.status,
      input.error_message ?? null,
      input.completed,
      input.job_id ?? null,
      input.worker_id ?? null,
    ],
  );
  if (!toolCall) {
    throw new Error('agent run worker lease lost before tool call write');
  }
  return toolCall;
}

export async function insertLlmCallRecord(input: {
  run_id?: string;
  trace_id?: string;
  agent_type?: string;
  model_name: string;
  prompt_version?: string;
  status: 'completed' | 'failed' | 'blocked';
  token_usage?: Record<string, unknown>;
  estimated_cost_cents?: number;
  latency_ms?: number;
  error_type?: string;
}): Promise<void> {
  await query(
    `
      INSERT INTO agent_llm_calls (
        run_id,
        trace_id,
        agent_type,
        model_name,
        prompt_version,
        status,
        token_usage,
        estimated_cost_cents,
        latency_ms,
        error_type
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
    `,
    [
      input.run_id ?? null,
      input.trace_id ?? null,
      input.agent_type ?? null,
      input.model_name,
      input.prompt_version ?? null,
      input.status,
      JSON.stringify(input.token_usage ?? {}),
      input.estimated_cost_cents ?? 0,
      input.latency_ms ?? null,
      input.error_type ?? null,
    ],
  );
}

export async function reserveDailyLlmBudget(input: {
  run_id?: string;
  trace_id?: string;
  model_name: string;
  reserved_tokens: number;
  reserved_cost_cents: number;
  max_daily_cost_cents: number;
}): Promise<string> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'agent-daily-llm-budget',
    ]);
    const spent = await tx.queryOne<{ cost: string }>(
      `
        SELECT
          (
            SELECT COALESCE(sum(estimated_cost_cents), 0)
            FROM agent_llm_calls
            WHERE created_at >= CURRENT_DATE
          ) + (
            SELECT COALESCE(sum(reserved_cost_cents), 0)
            FROM agent_daily_budget_reservations
            WHERE reservation_date = CURRENT_DATE
              AND status = 'reserved'
          ) AS cost
      `,
    );
    const projectedCost = Number(spent?.cost ?? 0) + input.reserved_cost_cents;
    if (projectedCost > input.max_daily_cost_cents) {
      throw new Error('AGENT_DAILY_COST_BUDGET_LIMIT');
    }
    const reservation = await tx.queryOne<{ reservation_id: string }>(
      `
        INSERT INTO agent_daily_budget_reservations (
          run_id,
          trace_id,
          model_name,
          reserved_tokens,
          reserved_cost_cents
        )
        VALUES ($1::uuid, $2, $3, $4, $5)
        RETURNING reservation_id::text
      `,
      [
        input.run_id ?? null,
        input.trace_id ?? null,
        input.model_name,
        input.reserved_tokens,
        input.reserved_cost_cents,
      ],
    );
    if (!reservation) {
      throw new Error('failed to reserve llm daily budget');
    }
    return reservation.reservation_id;
  });
}

export async function settleDailyLlmBudgetReservation(input: {
  reservation_id: string;
  actual_tokens?: number;
  actual_cost_cents?: number;
  released?: boolean;
}): Promise<void> {
  await query(
    `
      UPDATE agent_daily_budget_reservations
      SET
        status = CASE WHEN $4 THEN 'released' ELSE 'settled' END,
        actual_tokens = $2,
        actual_cost_cents = $3,
        settled_at = now()
      WHERE reservation_id = $1
        AND status = 'reserved'
    `,
    [
      input.reservation_id,
      input.actual_tokens ?? 0,
      input.actual_cost_cents ?? 0,
      input.released ?? false,
    ],
  );
}

export async function listToolCallsByRunId(runId: string): Promise<AgentToolCallRow[]> {
  return query<AgentToolCallRow>(
    `
      ${toolCallSelectSql()}
      WHERE run_id = $1
      ORDER BY started_at ASC, tool_call_id ASC
    `,
    [runId],
  );
}

export async function countToolCallsByRunIdAndAgentType(input: {
  run_id: string;
  agent_type: string;
}): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `
      SELECT COUNT(*)::text AS total
      FROM agent_tool_calls
      WHERE run_id = $1::uuid
        AND input->>'agent_type' = $2
    `,
    [input.run_id, input.agent_type],
  );
  return Number(row?.total ?? '0');
}

export async function countRunsByActorSince(input: {
  actor_id: string;
  since: Date;
}): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `
      SELECT count(*)::text
      FROM agent_runs
      WHERE actor_id = $1
        AND started_at >= $2
    `,
    [input.actor_id, input.since.toISOString()],
  );
  return Number(row?.count ?? 0);
}

export async function countActiveRunsByActor(actorId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `
      SELECT count(*)::text
      FROM agent_runs
      WHERE actor_id = $1
        AND status IN ('queued', 'running', 'resuming')
    `,
    [actorId],
  );
  return Number(row?.count ?? 0);
}

export async function countActiveQuotaReservationsByActor(actorId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `
      SELECT count(*)::text
      FROM agent_quota_reservations
      WHERE actor_id = $1
        AND status = 'active'
        AND reservation_date = CURRENT_DATE
    `,
    [actorId],
  );
  return Number(row?.count ?? 0);
}

export async function countActiveRunsGlobal(): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `
      SELECT count(*)::text
      FROM agent_runs
      WHERE status IN ('queued', 'running', 'resuming')
    `,
  );
  return Number(row?.count ?? 0);
}

export async function countRunsByEnterpriseSince(input: {
  enterprise_id: string;
  since: Date;
}): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `
      SELECT count(*)::text
      FROM agent_runs
      WHERE started_at >= $2
        AND state->'input'->>'enterprise_id' = $1
    `,
    [input.enterprise_id, input.since.toISOString()],
  );
  return Number(row?.count ?? 0);
}

export async function countActiveQuotaReservationsByEnterprise(
  enterpriseId: string,
): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `
      SELECT count(*)::text
      FROM agent_quota_reservations
      WHERE enterprise_id = $1
        AND status = 'active'
        AND reservation_date = CURRENT_DATE
    `,
    [enterpriseId],
  );
  return Number(row?.count ?? 0);
}

export async function sumRunTokenUsage(runId: string): Promise<number> {
  const row = await queryOne<{ total_tokens: string | null }>(
    `
      SELECT COALESCE(sum((token_usage->>'total_tokens')::int), 0)::text AS total_tokens
      FROM agent_run_steps
      WHERE run_id = $1
        AND token_usage ? 'total_tokens'
    `,
    [runId],
  );
  return Number(row?.total_tokens ?? 0);
}

export async function sumDailyTokenUsage(since: Date): Promise<number> {
  const row = await queryOne<{ total_tokens: string | null }>(
    `
      SELECT COALESCE(sum((s.token_usage->>'total_tokens')::int), 0)::text AS total_tokens
      FROM agent_run_steps s
      INNER JOIN agent_runs r ON r.run_id = s.run_id
      WHERE r.started_at >= $1
        AND s.token_usage ? 'total_tokens'
    `,
    [since.toISOString()],
  );
  return Number(row?.total_tokens ?? 0);
}

export async function sumRunLlmCostCents(runId: string): Promise<number> {
  const row = await queryOne<{ cost: string | null }>(
    `
      SELECT COALESCE(sum(estimated_cost_cents), 0)::text AS cost
      FROM agent_llm_calls
      WHERE run_id = $1
    `,
    [runId],
  );
  return Number(row?.cost ?? 0);
}

export async function sumRunLlmTokenUsage(runId: string): Promise<number> {
  const row = await queryOne<{ total_tokens: string | null }>(
    `
      SELECT COALESCE(sum((token_usage->>'total_tokens')::int), 0)::text AS total_tokens
      FROM agent_llm_calls
      WHERE run_id = $1
        AND token_usage ? 'total_tokens'
    `,
    [runId],
  );
  return Number(row?.total_tokens ?? 0);
}

export async function sumDailyLlmCostCents(since: Date): Promise<number> {
  const row = await queryOne<{ cost: string | null }>(
    `
      SELECT COALESCE(sum(estimated_cost_cents), 0)::text AS cost
      FROM agent_llm_calls
      WHERE created_at >= $1
    `,
    [since.toISOString()],
  );
  return Number(row?.cost ?? 0);
}

export async function sumDailyReservedLlmCostCents(): Promise<number> {
  const row = await queryOne<{ cost: string | null }>(
    `
      SELECT COALESCE(sum(reserved_cost_cents), 0)::text AS cost
      FROM agent_daily_budget_reservations
      WHERE reservation_date = CURRENT_DATE
        AND status = 'reserved'
    `,
  );
  return Number(row?.cost ?? 0);
}

export async function sumDailySettledLlmCostCents(): Promise<number> {
  const row = await queryOne<{ cost: string | null }>(
    `
      SELECT COALESCE(sum(actual_cost_cents), 0)::text AS cost
      FROM agent_daily_budget_reservations
      WHERE reservation_date = CURRENT_DATE
        AND status = 'settled'
    `,
  );
  return Number(row?.cost ?? 0);
}

export async function getModelPrice(modelName: string): Promise<{
  input_cents_per_1k: number;
  output_cents_per_1k: number;
} | undefined> {
  const row = await queryOne<{
    input_cents_per_1k: string;
    output_cents_per_1k: string;
  }>(
    `
      SELECT input_cents_per_1k::text, output_cents_per_1k::text
      FROM agent_model_prices
      WHERE model_name = $1
    `,
    [modelName],
  );
  if (!row) {
    return undefined;
  }
  return {
    input_cents_per_1k: Number(row.input_cents_per_1k),
    output_cents_per_1k: Number(row.output_cents_per_1k),
  };
}

export async function findResumeRequest(input: {
  run_id: string;
  task_id: string;
  idempotency_key: string;
}): Promise<{
  resume_request_id: string;
  status: string;
  response_run_id: string | null;
  error_message: string | null;
  payload_hash: string;
} | undefined> {
  return queryOne(
    `
      SELECT
        resume_request_id::text,
        status,
        response_run_id::text,
        error_message,
        payload_hash
      FROM agent_resume_requests
      WHERE run_id = $1
        AND task_id = $2
        AND idempotency_key = $3
    `,
    [input.run_id, input.task_id, input.idempotency_key],
  );
}

export async function createResumeRequest(input: {
  run_id: string;
  task_id: string;
  idempotency_key: string;
  payload_hash: string;
}): Promise<{
  resume_request_id: string;
  status: string;
  payload_hash: string;
  created: boolean;
}> {
  const row = await queryOne<{
    resume_request_id: string;
    status: string;
    payload_hash: string;
    inserted: boolean;
  }>(
    `
      INSERT INTO agent_resume_requests (
        run_id,
        task_id,
        idempotency_key,
        payload_hash
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (run_id, task_id, idempotency_key)
      DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
      RETURNING
        resume_request_id::text,
        status,
        payload_hash,
        (xmax = 0) AS inserted
    `,
    [input.run_id, input.task_id, input.idempotency_key, input.payload_hash],
  );
  if (!row) {
    throw new Error('failed to create resume request');
  }
  return {
    resume_request_id: row.resume_request_id,
    status: row.status,
    payload_hash: row.payload_hash,
    created: row.inserted,
  };
}

export async function createQueuedResumeJob(input: {
  run_id: string;
  task_id: string;
  idempotency_key: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  state: AgentGraphState;
  expected_version?: number;
  max_attempts?: number;
}): Promise<{
  resume_request_id: string;
  status: string;
  payload_hash: string;
  created: boolean;
  run: AgentRunRow;
}> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `agent-resume:${input.run_id}:${input.task_id}`,
    ]);
    const active = await tx.queryOne<{
      resume_request_id: string;
      idempotency_key: string;
      payload_hash: string;
      status: string;
    }>(
      `
        SELECT
          resume_request_id::text,
          idempotency_key,
          payload_hash,
          status
        FROM agent_resume_requests
        WHERE run_id = $1
          AND task_id = $2
          AND status = 'running'
        LIMIT 1
      `,
      [input.run_id, input.task_id],
    );
    if (active && active.idempotency_key !== input.idempotency_key) {
      throw new Error('AGENT_RESUME_ACTIVE_CONFLICT');
    }
    const resume = await tx.queryOne<{
      resume_request_id: string;
      status: string;
      payload_hash: string;
      inserted: boolean;
    }>(
      `
        INSERT INTO agent_resume_requests (
          run_id,
          task_id,
          idempotency_key,
          payload_hash
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (run_id, task_id, idempotency_key)
        DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING
          resume_request_id::text,
          status,
          payload_hash,
          (xmax = 0) AS inserted
      `,
      [
        input.run_id,
        input.task_id,
        input.idempotency_key,
        input.payload_hash,
      ],
    );
    if (!resume) {
      throw new Error('failed to create resume request');
    }
    if (resume.payload_hash !== input.payload_hash) {
      throw new Error('AGENT_RESUME_IDEMPOTENCY_PAYLOAD_CONFLICT');
    }
    const updatedRun = await updateRunStateWithExecutor(tx, {
      run_id: input.run_id,
      status: 'resuming',
      current_node: 'resume_queued',
      state: input.state,
      expected_version: input.expected_version,
    });
    if (!updatedRun) {
      throw new Error('AGENT_RESUME_RUN_STATE_CONFLICT');
    }
    if (resume.inserted) {
      await insertRunJob(tx, {
        run_id: input.run_id,
        job_type: 'resume',
        payload: {
          ...input.payload,
          task_id: input.task_id,
          resume_request_id: resume.resume_request_id,
          payload_hash: input.payload_hash,
        },
        max_attempts: input.max_attempts,
      });
    }
    return {
      resume_request_id: resume.resume_request_id,
      status: resume.status,
      payload_hash: resume.payload_hash,
      created: resume.inserted,
      run: updatedRun,
    };
  });
}

export async function completeResumeRequest(input: {
  resume_request_id: string;
  run_id: string;
}): Promise<void> {
  await query(
    `
      UPDATE agent_resume_requests
      SET
        status = 'completed',
        response_run_id = $2,
        completed_at = now()
      WHERE resume_request_id = $1
    `,
    [input.resume_request_id, input.run_id],
  );
}

export async function failResumeRequest(input: {
  resume_request_id: string;
  error_message: string;
}): Promise<void> {
  await query(
    `
      UPDATE agent_resume_requests
      SET
        status = 'failed',
        error_message = $2,
        completed_at = now()
      WHERE resume_request_id = $1
    `,
    [input.resume_request_id, input.error_message],
  );
}

export async function resetResumeRequestForRetry(input: {
  resume_request_id: string;
  payload_hash: string;
}): Promise<void> {
  await query(
    `
      UPDATE agent_resume_requests
      SET
        status = 'running',
        error_message = NULL,
        completed_at = NULL
      WHERE resume_request_id = $1
        AND payload_hash = $2
    `,
    [input.resume_request_id, input.payload_hash],
  );
}

export async function attachFallbackTaskToRun(input: {
  task_id: string;
  run_id: string;
  job_id?: string;
  worker_id?: string;
}): Promise<void> {
  const lease = getCurrentAgentLease();
  const rows = await query<{ task_id: string }>(
    `
      UPDATE fallback_tasks
      SET run_id = $2
      WHERE task_id = $1
        AND EXISTS (
          SELECT 1
          FROM agent_runs run_guard
          WHERE run_guard.run_id = $2
            AND (
              ($3::uuid IS NULL AND NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid IS NULL)
              OR EXISTS (
                SELECT 1
                FROM agent_run_jobs leased_job
                WHERE leased_job.job_id = $3::uuid
                  AND leased_job.run_id = run_guard.run_id
                  AND leased_job.status = 'running'
                  AND leased_job.locked_by = $4
              )
            )
        )
      RETURNING task_id::text
    `,
    [
      input.task_id,
      input.run_id,
      input.job_id ?? lease?.job_id ?? null,
      input.worker_id ?? lease?.worker_id ?? null,
    ],
  );
  if (rows.length === 0) {
    throw new Error('agent run worker lease lost before fallback task attach');
  }
}

function isSameBusinessScope(
  existingInput: Record<string, unknown>,
  nextInput: Record<string, unknown>,
): boolean {
  const keys = [
    'question',
    'policy_id',
    'enterprise_id',
    'application_id',
    'item_id',
  ];
  return keys.every((key) => normalizeScopeValue(existingInput[key]) === normalizeScopeValue(nextInput[key]));
}

async function insertRun(
  executor: Pick<DbTransaction, 'queryOne'>,
  input: {
    actor_id: string;
    entrypoint: AgentRunEntrypoint;
    trace_id: string;
    state: AgentGraphState;
    idempotency_key?: string;
    status?: AgentRunStatus;
  },
): Promise<AgentRunRow> {
  return executor.queryOne<AgentRunRow>(
    `
      INSERT INTO agent_runs (
        actor_id,
        entrypoint,
        trace_id,
        state,
        idempotency_key,
        current_node,
        status
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
      RETURNING
        run_id::text,
        actor_id,
        entrypoint,
        status,
        current_node,
        state,
        idempotency_key,
        trace_id,
        error_message,
        started_at::text,
        interrupted_at::text,
        completed_at::text,
        updated_at::text,
        version
    `,
    [
      input.actor_id,
      input.entrypoint,
      input.trace_id,
      JSON.stringify(input.state),
      input.idempotency_key ?? null,
      input.state.entrypoint,
      input.status ?? 'running',
    ],
  ) as Promise<AgentRunRow>;
}

async function insertRunJob(
  executor: Pick<DbTransaction, 'queryOne'>,
  input: {
    run_id: string;
    job_type: AgentRunJobType;
    payload?: Record<string, unknown>;
    priority?: number;
    max_attempts?: number;
  },
): Promise<AgentRunJobRow> {
  return executor.queryOne<AgentRunJobRow>(
    `
      INSERT INTO agent_run_jobs (
        run_id,
        job_type,
        payload,
        priority,
        max_attempts
      )
      VALUES ($1, $2, $3::jsonb, $4, $5)
      RETURNING
        job_id::text,
        run_id::text,
        job_type,
        status,
        priority,
        attempt_count,
        max_attempts,
        locked_by,
        locked_at::text,
        heartbeat_at::text,
        available_at::text,
        last_error,
        payload,
        created_at::text,
        updated_at::text
    `,
    [
      input.run_id,
      input.job_type,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 100,
      input.max_attempts ?? 2,
    ],
  ) as Promise<AgentRunJobRow>;
}

async function reserveAgentQuotaWithExecutor(
  executor: Pick<DbTransaction, 'query' | 'queryOne'>,
  input: {
    actor_id: string;
    enterprise_id?: string;
    max_concurrent_per_user?: number;
    max_concurrent_global?: number;
  },
): Promise<void> {
  await executor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    'agent-quota:global',
  ]);
  if (
    input.max_concurrent_per_user !== undefined ||
    input.max_concurrent_global !== undefined
  ) {
    const limits = await executor.queryOne<{
      user_active: string;
      global_active: string;
    }>(
      `
        SELECT
          (
            SELECT count(*)::text
            FROM agent_quota_reservations
            WHERE actor_id = $1
              AND status = 'active'
          ) AS user_active,
          (
            SELECT count(*)::text
            FROM agent_quota_reservations
            WHERE status = 'active'
          ) AS global_active,
          '0'::text AS enterprise_active
      `,
      [input.actor_id],
    );
    if (
      input.max_concurrent_per_user !== undefined &&
      Number(limits?.user_active ?? 0) >= input.max_concurrent_per_user
    ) {
      throw new Error('AGENT_USER_CONCURRENCY_LIMIT');
    }
    if (
      input.max_concurrent_global !== undefined &&
      Number(limits?.global_active ?? 0) >= input.max_concurrent_global
    ) {
      throw new Error('AGENT_GLOBAL_CONCURRENCY_LIMIT');
    }
  }
  await executor.queryOne(
    `
      INSERT INTO agent_quota_reservations (actor_id, enterprise_id)
      VALUES ($1, $2::uuid)
      RETURNING reservation_id
    `,
    [input.actor_id, input.enterprise_id ?? null],
  );
}

async function attachQuotaReservationToRunWithExecutor(
  executor: Pick<DbTransaction, 'query'>,
  input: {
    actor_id: string;
    run_id: string;
  },
): Promise<void> {
  await executor.query(
    `
      UPDATE agent_quota_reservations
      SET run_id = $2
      WHERE reservation_id = (
        SELECT reservation_id
        FROM agent_quota_reservations
        WHERE actor_id = $1
          AND run_id IS NULL
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      )
    `,
    [input.actor_id, input.run_id],
  );
}

function normalizeScopeValue(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}
