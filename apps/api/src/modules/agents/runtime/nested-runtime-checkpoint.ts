import { auditService } from '../../audit/audit.service.js';
import { queryOne } from '../../../db/query.js';
import { type AgentGraphState } from '../agents.types.js';
import {
  saveCheckpoint,
  type AgentCheckpointRow,
} from './checkpoint.repository.js';
import { type SubagentExecutionEnvelopeResult } from './subagent-execution-envelope.js';

export type NestedRuntimeCheckpointInput = {
  parent_state: AgentGraphState;
  child_state: AgentGraphState;
  result: SubagentExecutionEnvelopeResult;
  from_phase: string;
  target_phase: string;
};

export type NestedRuntimeCheckpointLookup = AgentCheckpointRow & {
  lineage: {
    parent_run_id: string;
    runtime_id: string;
    task_id?: string;
    resume_token: string;
    from_phase: string;
    target_phase: string;
    agent_type: string;
    status: string;
    checkpoint_status?: string;
  };
};

export async function saveNestedRuntimeCheckpoint(
  input: NestedRuntimeCheckpointInput,
): Promise<AgentCheckpointRow> {
  const checkpointState: AgentGraphState = {
    ...input.child_state,
    run_id: input.parent_state.run_id,
    trace_id: input.parent_state.trace_id,
    actor_id: input.parent_state.actor_id,
    entrypoint: input.parent_state.entrypoint,
    runtime: {
      ...(input.child_state.runtime ?? {}),
      nested_checkpoint: {
        parent_run_id: input.parent_state.run_id,
        runtime_id: input.result.runtime.runtime_id,
        task_id: input.result.runtime.task_id,
        resume_token: input.result.runtime.resume_token,
        from_phase: input.from_phase,
        target_phase: input.target_phase,
        agent_type: input.result.agent_type,
        status: input.result.status,
        checkpoint_status: toNestedCheckpointStatus(input.result.status),
      },
    },
  };
  const checkpoint = await saveCheckpoint({
    run_id: input.parent_state.run_id,
    state: checkpointState,
    status: toNestedCheckpointStatus(input.result.status),
  });
  await auditService.write({
    actor_id: input.parent_state.actor_id,
    action: 'agent_nested_runtime.checkpointed',
    target_type: 'agent_run',
    target_id: input.parent_state.run_id,
    trace_id: input.parent_state.trace_id,
    detail: {
      checkpoint_id: checkpoint.checkpoint_id,
      parent_run_id: input.parent_state.run_id,
      runtime_id: input.result.runtime.runtime_id,
      task_id: input.result.runtime.task_id,
      resume_token: input.result.runtime.resume_token,
      from_phase: input.from_phase,
      target_phase: input.target_phase,
      agent_type: input.result.agent_type,
      status: input.result.status,
      checkpoint_status: toNestedCheckpointStatus(input.result.status),
    },
  });
  return checkpoint;
}

export async function getNestedRuntimeCheckpointByResumeToken(input: {
  parent_run_id: string;
  resume_token: string;
}): Promise<NestedRuntimeCheckpointLookup | undefined> {
  const checkpoint = await queryOne<AgentCheckpointRow>(
    `
      SELECT
        checkpoint_id::text,
        run_id,
        state,
        status,
        created_at::text
      FROM langgraph_checkpoints
      WHERE run_id = $1
        AND status = 'nested_completed'
        AND state->'runtime'->'nested_checkpoint'->>'resume_token' = $2
      ORDER BY created_at DESC, checkpoint_id DESC
      LIMIT 1
    `,
    [input.parent_run_id, input.resume_token],
  );
  const lineage = checkpoint?.state.runtime?.nested_checkpoint;
  if (!checkpoint || !lineage) {
    return undefined;
  }
  return {
    ...checkpoint,
    lineage,
  };
}

export async function getNestedRuntimeCheckpointByRuntimeId(input: {
  parent_run_id: string;
  runtime_id: string;
}): Promise<NestedRuntimeCheckpointLookup | undefined> {
  const checkpoint = await queryOne<AgentCheckpointRow>(
    `
      SELECT
        checkpoint_id::text,
        run_id,
        state,
        status,
        created_at::text
      FROM langgraph_checkpoints
      WHERE run_id = $1
        AND status IN ('nested_completed', 'nested_interrupted', 'nested_failed')
        AND state->'runtime'->'nested_checkpoint'->>'runtime_id' = $2
      ORDER BY created_at DESC, checkpoint_id DESC
      LIMIT 1
    `,
    [input.parent_run_id, input.runtime_id],
  );
  const lineage = checkpoint?.state.runtime?.nested_checkpoint;
  if (!checkpoint || !lineage) {
    return undefined;
  }
  return {
    ...checkpoint,
    lineage,
  };
}

export function buildNestedRuntimeResumeState(input: {
  checkpoint: NestedRuntimeCheckpointLookup;
  resume_payload?: Record<string, unknown>;
}): AgentGraphState {
  return {
    ...input.checkpoint.state,
    current_node: 'nested_resume_queued',
    runtime: {
      ...(input.checkpoint.state.runtime ?? {}),
      nested_resume: {
        parent_run_id: input.checkpoint.lineage.parent_run_id,
        runtime_id: input.checkpoint.lineage.runtime_id,
        task_id: input.checkpoint.lineage.task_id,
        resume_token: input.checkpoint.lineage.resume_token,
        resumed_from_checkpoint_id: input.checkpoint.checkpoint_id,
        target_phase: input.checkpoint.lineage.target_phase,
        payload: input.resume_payload ?? {},
        status: 'resuming',
      },
    },
  };
}

function toNestedCheckpointStatus(
  status: string,
): 'nested_completed' | 'nested_interrupted' | 'nested_failed' {
  if (status === 'failed') {
    return 'nested_failed';
  }
  if (status === 'interrupted') {
    return 'nested_interrupted';
  }
  return 'nested_completed';
}
