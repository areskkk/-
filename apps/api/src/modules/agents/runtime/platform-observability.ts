import { ApiError } from '../../../common/errors/http-error.js';
import {
  type AgentRunRow,
  type AgentRunStepRow,
  type AgentToolCallRow,
} from '../agents.types.js';

export type ActionReplayEvent = {
  action_id: string;
  order: number;
  kind: 'step' | 'tool_call';
  node_name?: string;
  tool_name?: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error_message?: string | null;
  started_at: string;
  completed_at?: string | null;
};

export type ActionReplayTrace = {
  version: 'action_replay.v1';
  run_id: string;
  source_status: string;
  actions: ActionReplayEvent[];
};

export type EvalGateResult = {
  version: 'agent_eval_gate.v1';
  status: 'pass' | 'fail';
  checks: Array<{
    name: string;
    status: 'pass' | 'fail';
    observed: number;
    threshold: number;
  }>;
};

export type SlaGateInput = {
  max_failed_rate?: number;
  max_interrupted_rate?: number;
  max_fallback_overdue_count?: number;
  max_queue_depth?: number;
};

export function buildActionReplayTrace(input: {
  run: AgentRunRow;
  steps: AgentRunStepRow[];
  tool_calls: AgentToolCallRow[];
}): ActionReplayTrace {
  const stepEvents: ActionReplayEvent[] = input.steps.map((step, index) => ({
    action_id: step.step_id,
    order: index * 2,
    kind: 'step',
    node_name: step.node_name,
    status: step.status,
    input: step.input,
    output: step.output,
    error_message: step.error_message,
    started_at: step.started_at,
    completed_at: step.completed_at,
  }));
  const toolEvents: ActionReplayEvent[] = input.tool_calls.map((toolCall, index) => ({
    action_id: toolCall.tool_call_id,
    order: index * 2 + 1,
    kind: 'tool_call',
    tool_name: toolCall.tool_name,
    status: toolCall.status,
    input: toolCall.input,
    output: toolCall.output ?? {},
    error_message: toolCall.error_message,
    started_at: toolCall.started_at,
    completed_at: toolCall.completed_at,
  }));
  return {
    version: 'action_replay.v1',
    run_id: input.run.run_id,
    source_status: input.run.status,
    actions: [...stepEvents, ...toolEvents]
      .sort((left, right) => {
        const byTime = left.started_at.localeCompare(right.started_at);
        return byTime === 0 ? left.order - right.order : byTime;
      })
      .map((event, index) => ({
        ...event,
        order: index + 1,
      })),
  };
}

export function assertReplayTraceDeterministic(trace: ActionReplayTrace): void {
  const ids = new Set<string>();
  for (const action of trace.actions) {
    if (ids.has(action.action_id)) {
      throw new ApiError('CONFLICT', `duplicate replay action ${action.action_id}`);
    }
    ids.add(action.action_id);
  }
}

export function evaluateSlaGate(input: {
  metrics: {
    run_rates?: {
      failed_rate?: number;
      interrupted_rate?: number;
    };
    fallback_sla?: {
      overdue_count?: number;
    };
    queue_depth?: {
      queued?: number;
    };
  };
  policy: SlaGateInput;
}): EvalGateResult {
  const checks = [
    buildCheck({
      name: 'failed_rate',
      observed: input.metrics.run_rates?.failed_rate ?? 0,
      threshold: input.policy.max_failed_rate ?? 1,
      direction: 'lte',
    }),
    buildCheck({
      name: 'interrupted_rate',
      observed: input.metrics.run_rates?.interrupted_rate ?? 0,
      threshold: input.policy.max_interrupted_rate ?? 1,
      direction: 'lte',
    }),
    buildCheck({
      name: 'fallback_overdue_count',
      observed: input.metrics.fallback_sla?.overdue_count ?? 0,
      threshold: input.policy.max_fallback_overdue_count ?? Number.MAX_SAFE_INTEGER,
      direction: 'lte',
    }),
    buildCheck({
      name: 'queue_depth',
      observed: input.metrics.queue_depth?.queued ?? 0,
      threshold: input.policy.max_queue_depth ?? Number.MAX_SAFE_INTEGER,
      direction: 'lte',
    }),
  ];
  return {
    version: 'agent_eval_gate.v1',
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    checks,
  };
}

function buildCheck(input: {
  name: string;
  observed: number;
  threshold: number;
  direction: 'lte';
}): EvalGateResult['checks'][number] {
  return {
    name: input.name,
    observed: input.observed,
    threshold: input.threshold,
    status: input.observed <= input.threshold ? 'pass' : 'fail',
  };
}
