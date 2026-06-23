import { queryOne } from '../../../db/query.js';
import { type AgentGraphState } from '../agents.types.js';
import { getCurrentAgentLease } from './agent-lease-context.js';

export type AgentCheckpointRow = {
  checkpoint_id: string;
  run_id: string;
  state: AgentGraphState;
  status: string;
  created_at: string;
};

export async function saveCheckpoint(input: {
  run_id: string;
  state: AgentGraphState;
  status?: string;
}): Promise<AgentCheckpointRow> {
  const lease = getCurrentAgentLease();
  const checkpoint = await queryOne<AgentCheckpointRow>(
    `
      INSERT INTO langgraph_checkpoints (run_id, state, status)
      SELECT $1::uuid, $2::jsonb, $3
      FROM agent_runs run_guard
      WHERE run_guard.run_id = $1::uuid
        AND (
          ($4::uuid IS NULL AND NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid IS NULL)
          OR EXISTS (
            SELECT 1
            FROM agent_run_jobs leased_job
            WHERE leased_job.job_id = COALESCE($4::uuid, NULLIF(run_guard.state->'runtime'->>'job_id', '')::uuid)
              AND leased_job.run_id = $1::uuid
              AND leased_job.status = 'running'
              AND leased_job.locked_by = COALESCE($5, run_guard.state->'runtime'->>'worker_id')
          )
        )
      RETURNING
        checkpoint_id::text,
        run_id,
        state,
        status,
        created_at::text
    `,
    [
      input.run_id,
      JSON.stringify(input.state),
      input.status ?? 'active',
      lease?.job_id ?? null,
      lease?.worker_id ?? null,
    ],
  );
  if (!checkpoint) {
    throw new Error('agent run worker lease lost before checkpoint write');
  }
  return checkpoint;
}

export async function getLatestCheckpoint(
  runId: string,
): Promise<AgentCheckpointRow | undefined> {
  return queryOne<AgentCheckpointRow>(
    `
      SELECT
        checkpoint_id::text,
        run_id,
        state,
        status,
        created_at::text
      FROM langgraph_checkpoints
      WHERE run_id = $1
      ORDER BY created_at DESC, checkpoint_id DESC
      LIMIT 1
    `,
    [runId],
  );
}
