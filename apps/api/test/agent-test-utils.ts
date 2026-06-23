import { agentRunWorker } from '../src/modules/agents/runtime/agent-run-worker.js';
import { getRows } from './db-test-utils.js';

export async function drainAgentWorkerUntilIdle(maxRounds = 20): Promise<void> {
  for (let index = 0; index < maxRounds; index += 1) {
    const processed = await agentRunWorker.drainOnce(20);
    const active = await getRows<{ count: string }>(
      `
        SELECT count(*)::text
        FROM agent_run_jobs
        WHERE status IN ('queued', 'running')
      `,
    );
    if (processed === 0 && Number(active[0]?.count ?? 0) === 0) {
      return;
    }
  }
  throw new Error('agent worker did not become idle');
}

export async function readRun(runId: string): Promise<Record<string, unknown>> {
  const rows = await getRows<{ run: Record<string, unknown> }>(
    `
      SELECT to_jsonb(agent_runs.*) AS run
      FROM agent_runs
      WHERE run_id = $1
    `,
    [runId],
  );
  if (!rows[0]) {
    throw new Error(`run not found: ${runId}`);
  }
  return rows[0].run;
}
