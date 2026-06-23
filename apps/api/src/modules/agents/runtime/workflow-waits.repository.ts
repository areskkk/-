import { ApiError } from '../../../common/errors/http-error.js';
import { query, queryOne } from '../../../db/query.js';
import { updateRunState } from '../agents.repository.js';
import { type AgentRunRow } from '../agents.types.js';
import { auditService } from '../../audit/audit.service.js';
import {
  evaluateWorkflowSla,
  markWorkflowWaitResumable,
  readWorkflow,
  resumeWorkflowWait,
  type WorkflowWaitRecord,
} from './platform-workflow.js';
import {
  getWorkflowInstanceByResumeToken,
} from './workflow-instance.repository.js';

export type WorkflowWaitLookup = {
  run: AgentRunRow;
  wait: WorkflowWaitRecord;
};

export async function findWorkflowWaitByResumeToken(
  resumeToken: string,
): Promise<WorkflowWaitLookup | undefined> {
  const lookup = await getWorkflowInstanceByResumeToken(resumeToken);
  const wait = lookup?.workflow.waits.find((item) => item.resume_token === resumeToken);
  if (!lookup || !wait) {
    return undefined;
  }
  return {
    run: lookup.run,
    wait,
  };
}

export async function resumeWorkflowWaitByToken(input: {
  resume_token: string;
  payload?: Record<string, unknown>;
  actor_id: string;
  trace_id?: string;
}): Promise<AgentRunRow> {
  const lookup = await getWorkflowInstanceByResumeToken(input.resume_token);
  if (!lookup) {
    throw new ApiError('NOT_FOUND', 'workflow wait not found');
  }
  const resumable = markWorkflowWaitResumable({
    state: lookup.run.state,
    resume_token: input.resume_token,
    payload: input.payload,
  });
  const resumed = resumeWorkflowWait({
    state: resumable,
    resume_token: input.resume_token,
  });
  const updated = await updateRunState({
    run_id: lookup.run.run_id,
    status: lookup.run.status,
    current_node: lookup.run.current_node,
    state: resumed,
    expected_version: lookup.run.version,
    allow_terminal_override: true,
  });
  if (!updated) {
    throw new ApiError('CONFLICT', 'agent run state changed before workflow wait resume');
  }
  await saveWorkflowCheckpoint({
    run_id: updated.run_id,
    state: updated.state,
    status: 'workflow_wait_resumed',
  });
  await auditService.write({
    actor_id: input.actor_id,
    action: 'agent_workflow.wait_resumed',
    target_type: 'agent_run',
    target_id: updated.run_id,
    trace_id: input.trace_id ?? updated.trace_id ?? updated.state.trace_id,
    detail: {
      run_id: updated.run_id,
      resume_token: input.resume_token,
      workflow_id: readWorkflow(updated.state)?.workflow_id ?? null,
    },
  });
  return updated;
}

export async function scanAndEscalateExpiredWorkflowWaits(input: {
  now?: Date;
  actor_id: string;
  trace_id?: string;
  limit?: number;
}): Promise<{
  scanned: number;
  escalated: Array<{
    run_id: string;
    workflow_id: string;
    wait_ids: string[];
  }>;
}> {
  const rows = await query<AgentRunRow>(
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
      WHERE state->'runtime'->'workflow' IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(state->'runtime'->'workflow'->'waits') wait
          WHERE wait->>'status' = 'waiting'
            AND wait->>'expires_at' IS NOT NULL
            AND (wait->>'expires_at')::timestamptz <= $1::timestamptz
        )
      ORDER BY updated_at ASC
      LIMIT $2
    `,
    [
      (input.now ?? new Date()).toISOString(),
      input.limit ?? 100,
    ],
  );
  const escalated: Array<{
    run_id: string;
    workflow_id: string;
    wait_ids: string[];
  }> = [];
  for (const run of rows) {
    const before = readWorkflow(run.state);
    if (!before) {
      continue;
    }
    const evaluated = evaluateWorkflowSla({
      state: run.state,
      now: input.now,
    });
    const after = readWorkflow(evaluated);
    if (!after || JSON.stringify(before.waits) === JSON.stringify(after.waits)) {
      continue;
    }
    const updated = await updateRunState({
      run_id: run.run_id,
      status: after.status === 'failed' ? 'failed' : run.status,
      current_node: after.status === 'failed' ? 'workflow_failed' : run.current_node,
      state: evaluated,
      expected_version: run.version,
      error_message: after.status === 'failed' ? 'workflow wait expired' : run.error_message,
      allow_terminal_override: true,
    });
    if (!updated) {
      continue;
    }
    await saveWorkflowCheckpoint({
      run_id: updated.run_id,
      state: updated.state,
      status: 'workflow_wait_escalated',
    });
    const waitIds = after.waits
      .filter((wait, index) => wait.status !== before.waits[index]?.status)
      .map((wait) => wait.wait_id);
    await auditService.write({
      actor_id: input.actor_id,
      action: 'agent_workflow.wait_escalated',
      target_type: 'agent_run',
      target_id: updated.run_id,
      trace_id: input.trace_id ?? updated.trace_id ?? updated.state.trace_id,
      detail: {
        run_id: updated.run_id,
        workflow_id: after.workflow_id,
        wait_ids: waitIds,
      },
    });
    escalated.push({
      run_id: updated.run_id,
      workflow_id: after.workflow_id,
      wait_ids: waitIds,
    });
  }
  return {
    scanned: rows.length,
    escalated,
  };
}

async function saveWorkflowCheckpoint(input: {
  run_id: string;
  state: AgentRunRow['state'];
  status: string;
}): Promise<void> {
  await queryOne(
    `
      INSERT INTO langgraph_checkpoints (run_id, state, status)
      VALUES ($1::uuid, $2::jsonb, $3)
      RETURNING checkpoint_id
    `,
    [
      input.run_id,
      JSON.stringify(input.state),
      input.status,
    ],
  );
}
