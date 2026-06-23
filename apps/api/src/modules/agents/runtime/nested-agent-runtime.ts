import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentType } from '../../llm/model-registry.js';
import { type AgentGraphState, type AgentRunRow, type AgentRunStatus } from '../agents.types.js';
import { type NestedRuntimeCheckpointLookup, buildNestedRuntimeResumeState } from './nested-runtime-checkpoint.js';
import { verifySubagentResult } from './result-verifier.js';
import { type SubagentOutput } from './subagent-registry.js';

export type NestedAgentRuntimeResult = {
  state: AgentGraphState;
  parent_status: AgentRunStatus;
  current_node: string;
  checkpoint_status: 'nested_completed' | 'nested_interrupted' | 'nested_failed';
  step_status: 'completed' | 'interrupted' | 'failed';
  output: SubagentOutput | Record<string, unknown> | null;
  error_message?: string;
};

export async function resumeNestedAgentRuntime(input: {
  run: AgentRunRow;
  checkpoint: NestedRuntimeCheckpointLookup;
  resume_payload: Record<string, unknown>;
  execute_child?: (input: {
    state: AgentGraphState;
    checkpoint: NestedRuntimeCheckpointLookup;
    resume_payload: Record<string, unknown>;
  }) => Promise<{
    state: AgentGraphState;
    output: SubagentOutput | Record<string, unknown> | null;
  }>;
}): Promise<NestedAgentRuntimeResult> {
  const resumeState = buildNestedRuntimeResumeState({
    checkpoint: input.checkpoint,
    resume_payload: input.resume_payload,
  });
  const requestedAction = readString(input.resume_payload.child_action)
    ?? readString(input.resume_payload.action)
    ?? 'respond_final';
  if (requestedAction === 'request_human') {
    return buildInterruptedResult({
      state: resumeState,
      checkpoint: input.checkpoint,
      reason: readString(input.resume_payload.reason) ?? 'nested_child_requested_human',
    });
  }
  if (requestedAction === 'fail') {
    return buildFailedResult({
      state: resumeState,
      checkpoint: input.checkpoint,
      error_message: readString(input.resume_payload.error_message) ?? 'nested child runtime failed',
    });
  }
  try {
    const childResult = input.execute_child
      ? await input.execute_child({
          state: resumeState,
          checkpoint: input.checkpoint,
          resume_payload: input.resume_payload,
        })
      : buildDefaultChildResult({
          state: resumeState,
          checkpoint: input.checkpoint,
          resume_payload: input.resume_payload,
        });
    const output = verifyIfSubagentOutput(input.checkpoint, childResult.output);
    return buildCompletedResult({
      state: childResult.state,
      checkpoint: input.checkpoint,
      output,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    return buildFailedResult({
      state: resumeState,
      checkpoint: input.checkpoint,
      error_message: error instanceof Error ? error.message : 'nested child runtime failed',
    });
  }
}

function buildCompletedResult(input: {
  state: AgentGraphState;
  checkpoint: NestedRuntimeCheckpointLookup;
  output: SubagentOutput | Record<string, unknown> | null;
}): NestedAgentRuntimeResult {
  const state = withNestedResumeStatus(input.state, {
    status: 'completed',
    output: input.output,
  });
  return {
    state: {
      ...state,
      current_node: 'nested_runtime_completed',
    },
    parent_status: 'completed',
    current_node: 'nested_runtime_completed',
    checkpoint_status: 'nested_completed',
    step_status: 'completed',
    output: input.output,
  };
}

function buildInterruptedResult(input: {
  state: AgentGraphState;
  checkpoint: NestedRuntimeCheckpointLookup;
  reason: string;
}): NestedAgentRuntimeResult {
  const output = {
    reason: input.reason,
    runtime_id: input.checkpoint.lineage.runtime_id,
  };
  const state = withNestedResumeStatus(input.state, {
    status: 'interrupted',
    output,
  });
  return {
    state: {
      ...state,
      current_node: 'nested_runtime_request_human',
    },
    parent_status: 'interrupted',
    current_node: 'nested_runtime_request_human',
    checkpoint_status: 'nested_interrupted',
    step_status: 'interrupted',
    output,
  };
}

function buildFailedResult(input: {
  state: AgentGraphState;
  checkpoint: NestedRuntimeCheckpointLookup;
  error_message: string;
}): NestedAgentRuntimeResult {
  const state = withNestedResumeStatus(input.state, {
    status: 'failed',
    output: null,
    error_message: input.error_message,
  });
  return {
    state: {
      ...state,
      current_node: 'nested_runtime_failed',
      errors: [
        ...(state.errors ?? []),
        {
          node: input.checkpoint.lineage.runtime_id,
          message: input.error_message,
        },
      ],
    },
    parent_status: 'resume_failed',
    current_node: 'nested_runtime_failed',
    checkpoint_status: 'nested_failed',
    step_status: 'failed',
    output: null,
    error_message: input.error_message,
  };
}

function buildDefaultChildResult(input: {
  state: AgentGraphState;
  checkpoint: NestedRuntimeCheckpointLookup;
  resume_payload: Record<string, unknown>;
}): {
  state: AgentGraphState;
  output: Record<string, unknown>;
} {
  return {
    state: {
      ...input.state,
      current_node: 'nested_child_respond_final',
    },
    output: {
      resumed: true,
      runtime_id: input.checkpoint.lineage.runtime_id,
      task_id: input.checkpoint.lineage.task_id,
      payload: input.resume_payload,
    },
  };
}

function withNestedResumeStatus(inputState: AgentGraphState, input: {
  status: 'completed' | 'interrupted' | 'failed';
  output: unknown;
  error_message?: string;
}): AgentGraphState {
  const existing = inputState.runtime?.nested_resume;
  if (!existing) {
    throw new ApiError('INTERNAL_ERROR', 'nested resume state is missing');
  }
  return {
    ...inputState,
    runtime: {
      ...(inputState.runtime ?? {}),
      nested_resume: {
        parent_run_id: existing.parent_run_id,
        runtime_id: existing.runtime_id,
        task_id: existing.task_id,
        resume_token: existing.resume_token,
        resumed_from_checkpoint_id: existing.resumed_from_checkpoint_id,
        target_phase: existing.target_phase,
        payload: existing.payload,
        status: input.status,
        output: input.output,
        error_message: input.error_message,
        completed_at: new Date().toISOString(),
      },
    },
  };
}

function verifyIfSubagentOutput(
  checkpoint: NestedRuntimeCheckpointLookup,
  output: SubagentOutput | Record<string, unknown> | null,
): SubagentOutput | Record<string, unknown> | null {
  if (!output || checkpoint.lineage.agent_type === 'supervisor') {
    return output;
  }
  return verifySubagentResult({
    agent_type: checkpoint.lineage.agent_type as AgentType,
    output,
  }).output;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}
