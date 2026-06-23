import { ApiError } from '../../../common/errors/http-error.js';
import { queryOne } from '../../../db/query.js';
import {
  findRunById,
  updateRunState,
} from '../agents.repository.js';
import { type AgentRunRow } from '../agents.types.js';
import { saveCheckpoint } from './checkpoint.repository.js';
import {
  readWorkflow,
  type WorkflowInstanceState,
} from './platform-workflow.js';

export type WorkflowInstanceLookup = {
  run: AgentRunRow;
  workflow: WorkflowInstanceState;
};

export async function saveWorkflowInstance(input: {
  run: AgentRunRow;
  workflow: WorkflowInstanceState;
  checkpoint_status?: string;
}): Promise<AgentRunRow> {
  const state = {
    ...input.run.state,
    runtime: {
      ...(input.run.state.runtime ?? {}),
      workflow: input.workflow,
    },
  };
  const updated = await updateRunState({
    run_id: input.run.run_id,
    status: input.run.status,
    current_node: input.run.current_node,
    state,
    expected_version: input.run.version,
    allow_terminal_override: true,
  });
  if (!updated) {
    throw new ApiError('CONFLICT', 'agent run state changed before workflow save');
  }
  await saveCheckpoint({
    run_id: updated.run_id,
    state: updated.state,
    status: input.checkpoint_status ?? 'workflow_saved',
  });
  return updated;
}

export async function getWorkflowInstanceByRunId(
  runId: string,
): Promise<WorkflowInstanceLookup | undefined> {
  const run = await findRunById(runId);
  const workflow = run ? readWorkflow(run.state) : undefined;
  if (!run || !workflow) {
    return undefined;
  }
  return { run, workflow };
}

export async function getWorkflowInstanceByResumeToken(
  resumeToken: string,
): Promise<WorkflowInstanceLookup | undefined> {
  const run = await queryOne<AgentRunRow>(
    `
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
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          COALESCE(state->'runtime'->'workflow'->'waits', '[]'::jsonb)
        ) wait
        WHERE wait->>'resume_token' = $1
      )
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [resumeToken],
  );
  const workflow = run ? readWorkflow(run.state) : undefined;
  if (!run || !workflow) {
    return undefined;
  }
  return { run, workflow };
}
