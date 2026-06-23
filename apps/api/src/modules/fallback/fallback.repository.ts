import { query, queryOne } from '../../db/query.js';
import { assertRunLeaseActiveByRunId } from '../agents/agents.repository.js';
import {
  type FallbackResolutionType,
  type FallbackSourceType,
  type FallbackStatus,
  type FallbackTaskRow,
} from './fallback.types.js';

export type InsertFallbackTaskResult = {
  task: FallbackTaskRow;
  created: boolean;
};

function fallbackTaskSelectSql(): string {
  return `
    SELECT
      task_id::text,
      run_id,
      reason,
      source_type,
      source_id,
      context,
      status::text AS status,
      owner_team,
      due_at::text,
      resolved_payload,
      resolution_type,
      resolved_by::text,
      resolved_at::text,
      created_at::text,
      updated_at::text
    FROM fallback_tasks
  `;
}

export async function insertFallbackTaskIfNotExists(input: {
  source_type: FallbackSourceType;
  source_id: string;
  reason: string;
  context: Record<string, unknown>;
  run_id?: string;
  job_id?: string;
  worker_id?: string;
}): Promise<InsertFallbackTaskResult> {
  const inserted = await queryOne<FallbackTaskRow>(
    `
      INSERT INTO fallback_tasks (source_type, source_id, reason, context)
      SELECT $1, $2, $3, $4::jsonb
      WHERE (
        $5::uuid IS NULL
        OR EXISTS (
          SELECT 1
          FROM agent_runs run_guard
          WHERE run_guard.run_id = $5::uuid
            AND (
              ($6::uuid IS NULL AND NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid IS NULL)
              OR EXISTS (
                SELECT 1
                FROM agent_run_jobs leased_job
                WHERE leased_job.job_id = COALESCE($6::uuid, NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid)
                  AND leased_job.run_id = run_guard.run_id
                  AND leased_job.status = 'running'
                  AND leased_job.locked_by = COALESCE($7, run_guard.state->'runtime'->>'worker_id')
              )
            )
        )
      )
      ON CONFLICT (source_type, source_id, reason)
      WHERE status = 'pending'
      DO NOTHING
      RETURNING
        task_id::text,
        run_id,
        reason,
        source_type,
        source_id,
        context,
        status::text AS status,
        owner_team,
        due_at::text,
        resolved_payload,
        resolution_type,
        resolved_by::text,
        resolved_at::text,
        created_at::text,
        updated_at::text
    `,
    [
      input.source_type,
      input.source_id,
      input.reason,
      JSON.stringify(input.context),
      input.run_id ?? null,
      input.job_id ?? null,
      input.worker_id ?? null,
    ],
  );

  if (inserted) {
    return { task: inserted, created: true };
  }

  if (input.run_id && !(await assertRunLeaseActiveByRunId({
    run_id: input.run_id,
    job_id: input.job_id,
    worker_id: input.worker_id,
  }))) {
    throw new Error('agent run worker lease lost before fallback task creation');
  }

  const existing = await queryOne<FallbackTaskRow>(
    `
      ${fallbackTaskSelectSql()}
      WHERE source_type = $1
        AND source_id = $2
        AND reason = $3
        AND status = 'pending'
      ORDER BY created_at DESC, task_id DESC
      LIMIT 1
    `,
    [input.source_type, input.source_id, input.reason],
  );

  if (!existing) {
    throw new Error('Failed to find existing fallback task');
  }

  return { task: existing, created: false };
}

export async function listFallbackTasks(input: {
  limit: number;
  offset: number;
  status?: FallbackStatus;
  source_type?: FallbackSourceType;
}): Promise<FallbackTaskRow[]> {
  const filters: string[] = [];
  const params: unknown[] = [];

  if (input.status) {
    params.push(input.status);
    filters.push(`status = $${params.length}`);
  }

  if (input.source_type) {
    params.push(input.source_type);
    filters.push(`source_type = $${params.length}`);
  }

  params.push(input.limit);
  const limitParam = params.length;
  params.push(input.offset);
  const offsetParam = params.length;

  return query<FallbackTaskRow>(
    `
      ${fallbackTaskSelectSql()}
      ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY created_at DESC, task_id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `,
    params,
  );
}

export async function countFallbackTasks(input: {
  status?: FallbackStatus;
  source_type?: FallbackSourceType;
}): Promise<number> {
  const filters: string[] = [];
  const params: unknown[] = [];

  if (input.status) {
    params.push(input.status);
    filters.push(`status = $${params.length}`);
  }

  if (input.source_type) {
    params.push(input.source_type);
    filters.push(`source_type = $${params.length}`);
  }

  const row = await queryOne<{ total: string }>(
    `
      SELECT COUNT(*)::text AS total
      FROM fallback_tasks
      ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
    `,
    params,
  );

  return Number(row?.total ?? '0');
}

export async function findFallbackTaskById(
  taskId: string,
): Promise<FallbackTaskRow | undefined> {
  return queryOne<FallbackTaskRow>(
    `
      ${fallbackTaskSelectSql()}
      WHERE task_id = $1
    `,
    [taskId],
  );
}

export async function findFallbackTaskByRun(input: {
  task_id: string;
  run_id: string;
}): Promise<FallbackTaskRow | undefined> {
  return queryOne<FallbackTaskRow>(
    `
      ${fallbackTaskSelectSql()}
      WHERE task_id = $1
        AND run_id = $2
    `,
    [input.task_id, input.run_id],
  );
}

export async function resolveFallbackTask(input: {
  task_id: string;
  resolution_type: FallbackResolutionType;
  resolved_payload: Record<string, unknown>;
  resolved_by: string;
  status: 'resolved' | 'closed';
}): Promise<FallbackTaskRow | undefined> {
  return queryOne<FallbackTaskRow>(
    `
      UPDATE fallback_tasks
      SET
        status = $2,
        resolution_type = $3,
        resolved_payload = $4::jsonb,
        resolved_by = $5,
        resolved_at = now()
      WHERE task_id = $1
        AND status = 'pending'
      RETURNING
        task_id::text,
        run_id,
        reason,
        source_type,
        source_id,
        context,
        status::text AS status,
        owner_team,
        due_at::text,
        resolved_payload,
        resolution_type,
        resolved_by::text,
        resolved_at::text,
        created_at::text,
        updated_at::text
    `,
    [
      input.task_id,
      input.status,
      input.resolution_type,
      JSON.stringify(input.resolved_payload),
      input.resolved_by,
    ],
  );
}
