import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentType } from '../../llm/model-registry.js';
import { type AgentGraphState } from '../agents.types.js';
import {
  assertSubagentPermission,
  DEFAULT_SUBAGENT_BUDGET,
  type SubagentBudget,
  type SubagentOutput,
  type SubagentPermissionScope,
} from './subagent-registry.js';

export type SubagentExecutionEnvelopeConfig = {
  agent_type: AgentType;
  permission_scope: SubagentPermissionScope;
  runtime: {
    parent_run_id?: string;
    task_id?: string;
    runtime_id: string;
    checkpoint_id: string;
    resume_token: string;
  };
  budget: {
    max_turns: number;
    max_tool_calls: number;
    max_tokens?: number;
  };
  capabilities: {
    independent_tool_loop: boolean;
    can_delegate: boolean;
    can_request_human: boolean;
  };
};

export type SubagentExecutionEnvelopeResult = {
  agent_type: AgentType;
  status: 'completed' | 'failed';
  runtime: SubagentExecutionEnvelopeConfig['runtime'];
  permission_scope: SubagentPermissionScope;
  budget: SubagentExecutionEnvelopeConfig['budget'];
  capabilities: SubagentExecutionEnvelopeConfig['capabilities'];
  turn_count: number;
  tool_call_count: number;
  output: SubagentOutput | null;
  error_message?: string;
};

export function createSubagentExecutionEnvelope(input: {
  agent_type: AgentType;
  permission_scope: SubagentPermissionScope;
  budget?: SubagentBudget;
  parent_run_id?: string;
  task_id?: string;
}): SubagentExecutionEnvelopeConfig {
  assertSubagentPermission(input.permission_scope, input.agent_type);
  const budget = input.budget ?? DEFAULT_SUBAGENT_BUDGET;
  return {
    agent_type: input.agent_type,
    permission_scope: input.permission_scope,
    runtime: createNestedRuntimeRef({
      parent_run_id: input.parent_run_id,
      task_id: input.task_id,
      agent_type: input.agent_type,
    }),
    budget: {
      max_turns: budget.max_turns_per_subagent,
      max_tool_calls: budget.max_tool_calls_per_subagent,
    },
    capabilities: {
      independent_tool_loop: false,
      can_delegate: false,
      can_request_human: true,
    },
  };
}

export async function runSubagentExecutionEnvelope(input: {
  config: SubagentExecutionEnvelopeConfig;
  state: AgentGraphState;
  task_input: Record<string, unknown>;
  handler: (input: {
    state: AgentGraphState;
    task_input: Record<string, unknown>;
    config: SubagentExecutionEnvelopeConfig;
  }) => Promise<{
    state: AgentGraphState;
    output: SubagentOutput;
    turn_count?: number;
    tool_call_count?: number;
  }>;
}): Promise<{
  state: AgentGraphState;
  result: SubagentExecutionEnvelopeResult;
}> {
  assertSubagentPermission(
    input.config.permission_scope,
    input.config.agent_type,
  );
  const result = await input.handler({
    state: input.state,
    task_input: input.task_input,
    config: input.config,
  });
  const turnCount = result.turn_count ?? 1;
  const toolCallCount = result.tool_call_count ?? 0;
  if (turnCount > input.config.budget.max_turns) {
    throw new ApiError(
      'RATE_LIMITED',
      `subagent ${input.config.agent_type} exceeded turn budget`,
    );
  }
  if (toolCallCount > input.config.budget.max_tool_calls) {
    throw new ApiError(
      'RATE_LIMITED',
      `subagent ${input.config.agent_type} exceeded tool call budget`,
    );
  }
  return {
    state: result.state,
    result: {
      agent_type: input.config.agent_type,
      status: 'completed',
      runtime: input.config.runtime,
      permission_scope: input.config.permission_scope,
      budget: input.config.budget,
      capabilities: input.config.capabilities,
      turn_count: turnCount,
      tool_call_count: toolCallCount,
      output: result.output,
    },
  };
}

function createNestedRuntimeRef(input: {
  parent_run_id?: string;
  task_id?: string;
  agent_type: AgentType;
}): SubagentExecutionEnvelopeConfig['runtime'] {
  const taskPart = input.task_id ?? input.agent_type;
  const parentPart = input.parent_run_id ?? 'detached';
  const runtimeId = `subagent:${parentPart}:${taskPart}`;
  return {
    parent_run_id: input.parent_run_id,
    task_id: input.task_id,
    runtime_id: runtimeId,
    checkpoint_id: `${runtimeId}:checkpoint:latest`,
    resume_token: `${runtimeId}:resume`,
  };
}
