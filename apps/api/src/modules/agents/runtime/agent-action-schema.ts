import { LlmError } from '../../llm/llm.types.js';
import { type AgentType } from '../../llm/model-registry.js';
import { type AgentToolName } from '../tools/tool.types.js';
import { type AgentPhase } from './phase-policy.js';

export type AgentActionType =
  | 'call_tool'
  | 'delegate_subagent'
  | 'respond_final'
  | 'request_human'
  | 'update_plan'
  | 'stop_run';

export type AgentAction =
  | {
      action: 'call_tool';
      tool_name: AgentToolName;
      tool_input: Record<string, unknown>;
      rationale?: string;
    }
  | {
      action: 'delegate_subagent';
      agent_type?: AgentType;
      subagents?: AgentType[];
      target_phase?: AgentPhase;
      task_input: Record<string, unknown>;
      rationale?: string;
    }
  | {
      action: 'respond_final';
      answer: string;
      confidence: number;
      citations?: unknown[];
      rationale?: string;
    }
  | {
      action: 'request_human';
      reason: string;
      context?: Record<string, unknown>;
    }
  | {
      action: 'update_plan';
      plan_update: string;
      open_tasks?: string[];
      completed_tasks?: string[];
    }
  | {
      action: 'stop_run';
      reason: string;
      status?: 'failed' | 'cancelled';
    };

export function validateAgentAction(input: {
  json: unknown;
  agent_type: AgentType;
  model: string;
  trace_id?: string;
}): AgentAction {
  const value = assertObject(input.json, input);
  const action = assertString(value, 'action', input) as AgentActionType;
  switch (action) {
    case 'call_tool':
      return {
        action,
        tool_name: assertString(value, 'tool_name', input) as AgentToolName,
        tool_input: optionalObject(value.tool_input) ?? {},
        rationale: optionalString(value.rationale),
      };
    case 'delegate_subagent':
      return {
        action,
        agent_type: typeof value.agent_type === 'string'
          ? assertString(value, 'agent_type', input) as AgentType
          : undefined,
        subagents: optionalStringArray(value.subagents) as AgentType[] | undefined,
        target_phase: typeof value.target_phase === 'string'
          ? assertString(value, 'target_phase', input) as AgentPhase
          : undefined,
        task_input: optionalObject(value.task_input) ?? {},
        rationale: optionalString(value.rationale),
      };
    case 'respond_final':
      return {
        action,
        answer: assertString(value, 'answer', input),
        confidence: assertConfidence(value.confidence, input),
        citations: Array.isArray(value.citations) ? value.citations : undefined,
        rationale: optionalString(value.rationale),
      };
    case 'request_human':
      return {
        action,
        reason: assertString(value, 'reason', input),
        context: optionalObject(value.context),
      };
    case 'update_plan':
      return {
        action,
        plan_update: assertString(value, 'plan_update', input),
        open_tasks: optionalStringArray(value.open_tasks),
        completed_tasks: optionalStringArray(value.completed_tasks),
      };
    case 'stop_run':
      return {
        action,
        reason: assertString(value, 'reason', input),
        status: value.status === 'cancelled' ? 'cancelled' : 'failed',
      };
    default:
      throwInvalid(input, `unsupported agent action: ${String(action)}`);
  }
}

function assertObject(
  value: unknown,
  context: ErrorContext,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwInvalid(context, 'agent action must be a json object');
  }
  return value as Record<string, unknown>;
}

function assertString(
  value: Record<string, unknown>,
  field: string,
  context: ErrorContext,
): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
    throwInvalid(context, `agent action field ${field} must be a non-empty string`);
  }
  return fieldValue.trim();
}

function assertConfidence(value: unknown, context: ErrorContext): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throwInvalid(context, 'agent action field confidence must be between 0 and 1');
  }
  return value;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

type ErrorContext = {
  agent_type: AgentType;
  model: string;
  trace_id?: string;
};

function throwInvalid(context: ErrorContext, message: string): never {
  throw new LlmError({
    type: 'invalid_response',
    message,
    retryable: false,
    provider: 'agent_runtime',
    model: context.model,
    trace_id: context.trace_id,
  });
}
