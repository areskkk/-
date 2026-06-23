import { query, queryOne } from '../../db/query.js';

export type OcrJobRow = {
  job_id: string;
  material_id: string;
  actor_id: string;
  trace_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  attempt_count: number;
  max_attempts: number;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

const OCR_WORKER_LEASE_EXPIRED = 'ocr worker lease expired';

export async function enqueueOcrJob(input: {
  material_id: string;
  actor_id: string;
  trace_id: string;
}): Promise<{ job: OcrJobRow; created: boolean }> {
  const job = await queryOne<OcrJobRow & { created: boolean }>(
    `
      WITH inserted AS (
        INSERT INTO ocr_jobs (material_id, actor_id, trace_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (material_id) WHERE status IN ('queued', 'running')
        DO NOTHING
        RETURNING
          job_id::text,
          material_id::text,
          actor_id::text,
          trace_id,
          status,
          attempt_count,
          max_attempts,
          locked_by,
          last_error,
          created_at::text,
          updated_at::text,
          true AS created
      )
      SELECT * FROM inserted
      UNION ALL
      SELECT
        job_id::text,
        material_id::text,
        actor_id::text,
        trace_id,
        status,
        attempt_count,
        max_attempts,
        locked_by,
        last_error,
        created_at::text,
        updated_at::text,
        false AS created
      FROM ocr_jobs
      WHERE material_id = $1
        AND status IN ('queued', 'running')
        AND NOT EXISTS (SELECT 1 FROM inserted)
      ORDER BY created DESC
      LIMIT 1
    `,
    [input.material_id, input.actor_id, input.trace_id],
  );
  if (!job) {
    throw new Error('Failed to enqueue OCR job');
  }
  return { job, created: job.created };
}

export async function claimNextOcrJob(input: {
  worker_id: string;
  stale_running_ms: number;
}): Promise<OcrJobRow | undefined> {
  await query(
    `
      WITH expired AS (
        UPDATE ocr_jobs
        SET
          status = CASE WHEN attempt_count + 1 >= max_attempts THEN 'failed' ELSE 'queued' END,
          attempt_count = attempt_count + 1,
          locked_by = NULL,
          locked_at = NULL,
          available_at = now(),
          last_error = $2
        WHERE status = 'running'
          AND locked_at < now() - ($1::int * interval '1 millisecond')
        RETURNING
          job_id,
          material_id,
          actor_id,
          trace_id,
          status,
          last_error
      ),
      failed_materials AS (
        UPDATE materials m
        SET ocr_status = 'failed'
        FROM expired e
        WHERE e.status = 'failed'
          AND m.material_id = e.material_id
          AND m.ocr_status = 'pending'
        RETURNING
          m.material_id,
          m.application_id,
          m.material_type,
          e.actor_id,
          e.trace_id,
          e.last_error
      )
      INSERT INTO audit_logs (actor_id, action, target_type, target_id, trace_id, detail)
      SELECT
        actor_id,
        'material.ocr.analyze_failed',
        'material',
        material_id::text,
        trace_id,
        jsonb_build_object(
          'application_id', application_id,
          'material_type', material_type,
          'ocr_status', 'failed',
          'error_message', last_error
        )
      FROM failed_materials
    `,
    [input.stale_running_ms, OCR_WORKER_LEASE_EXPIRED],
  );

  return queryOne<OcrJobRow>(
    `
      WITH candidate AS (
        SELECT job_id
        FROM ocr_jobs
        WHERE status = 'queued'
          AND available_at <= now()
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ocr_jobs j
      SET
        status = 'running',
        attempt_count = CASE
          WHEN j.last_error = $2 THEN j.attempt_count
          ELSE j.attempt_count + 1
        END,
        locked_by = $1,
        locked_at = now(),
        last_error = j.last_error
      FROM candidate
      WHERE j.job_id = candidate.job_id
      RETURNING
        j.job_id::text,
        j.material_id::text,
        j.actor_id::text,
        j.trace_id,
        j.status,
        j.attempt_count,
        j.max_attempts,
        j.locked_by,
        j.last_error,
        j.created_at::text,
        j.updated_at::text
    `,
    [input.worker_id, OCR_WORKER_LEASE_EXPIRED],
  );
}

export async function heartbeatOcrJob(input: {
  job_id: string;
  worker_id: string;
}): Promise<boolean> {
  const rows = await query<{ job_id: string }>(
    `
      UPDATE ocr_jobs
      SET locked_at = now()
      WHERE job_id = $1
        AND status = 'running'
        AND locked_by = $2
      RETURNING job_id::text
    `,
    [input.job_id, input.worker_id],
  );
  return rows.length > 0;
}

export async function completeLeasedOcrJob(input: {
  job_id: string;
  worker_id: string;
}): Promise<boolean> {
  const rows = await query<{ job_id: string }>(
    `
      UPDATE ocr_jobs
      SET status = 'completed', locked_by = NULL, locked_at = NULL, last_error = NULL
      WHERE job_id = $1
        AND status = 'running'
        AND locked_by = $2
      RETURNING job_id::text
    `,
    [input.job_id, input.worker_id],
  );
  return rows.length > 0;
}

export async function failLeasedOcrJob(input: {
  job_id: string;
  worker_id: string;
  error_message: string;
  retry_delay_ms?: number;
}): Promise<OcrJobRow | undefined> {
  return queryOne<OcrJobRow>(
    `
      UPDATE ocr_jobs
      SET
        status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
        locked_by = NULL,
        locked_at = NULL,
        available_at = CASE
          WHEN attempt_count >= max_attempts THEN available_at
          ELSE now() + ($4::int * interval '1 millisecond')
        END,
        last_error = $3
      WHERE job_id = $1
        AND status = 'running'
        AND locked_by = $2
      RETURNING
        job_id::text,
        material_id::text,
        actor_id::text,
        trace_id,
        status,
        attempt_count,
        max_attempts,
        locked_by,
        last_error,
        created_at::text,
        updated_at::text
    `,
    [input.job_id, input.worker_id, input.error_message, input.retry_delay_ms ?? 1000],
  );
}
