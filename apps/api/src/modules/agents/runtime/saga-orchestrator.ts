import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentGraphState } from '../agents.types.js';
import { type AgentToolName } from '../tools/tool.types.js';
import { type ToolSemanticDecision } from './tool-semantic-registry.js';

export type SagaStepStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'compensated'
  | 'compensation_failed';

export type SagaStepRecord = {
  saga_id: string;
  step_id: string;
  tool_name: AgentToolName;
  status: SagaStepStatus;
  semantic: ToolSemanticDecision;
  started_at: string;
  completed_at?: string;
  failure_reason?: string;
  compensation?: {
    status: 'not_required' | 'pending' | 'completed' | 'failed';
    action?: string;
    reason?: string;
    completed_at?: string;
  };
};

export function beginSagaStep(input: {
  state: AgentGraphState;
  tool_name: AgentToolName;
  semantic: ToolSemanticDecision;
}): {
  state: AgentGraphState;
  step: SagaStepRecord;
} {
  const step: SagaStepRecord = {
    saga_id: readSagaId(input.state) ?? randomUUID(),
    step_id: randomUUID(),
    tool_name: input.tool_name,
    status: 'pending',
    semantic: input.semantic,
    started_at: new Date().toISOString(),
    compensation: {
      status: input.semantic.compensation_required ? 'pending' : 'not_required',
    },
  };
  return {
    state: upsertSagaStep(input.state, step),
    step,
  };
}

export function completeSagaStep(input: {
  state: AgentGraphState;
  step_id: string;
}): AgentGraphState {
  return updateSagaStep(input.state, input.step_id, (step) => ({
    ...step,
    status: 'completed',
    completed_at: new Date().toISOString(),
  }));
}

export function failSagaStep(input: {
  state: AgentGraphState;
  step_id: string;
  reason: string;
}): AgentGraphState {
  return updateSagaStep(input.state, input.step_id, (step) => ({
    ...step,
    status: 'failed',
    completed_at: new Date().toISOString(),
    failure_reason: input.reason,
  }));
}

export function updateSagaCompensation(input: {
  state: AgentGraphState;
  step_id: string;
  status: 'completed' | 'failed';
  action?: string;
  reason?: string;
}): AgentGraphState {
  return updateSagaStep(input.state, input.step_id, (step) => ({
    ...step,
    status: input.status === 'completed' ? 'compensated' : 'compensation_failed',
    compensation: {
      status: input.status,
      action: input.action,
      reason: input.reason,
      completed_at: new Date().toISOString(),
    },
  }));
}

export function readSagaSteps(state: AgentGraphState): SagaStepRecord[] {
  const runtime = state.runtime as Record<string, unknown> | undefined;
  const saga = runtime?.saga;
  if (!saga || typeof saga !== 'object' || Array.isArray(saga)) {
    return [];
  }
  const steps = (saga as { steps?: unknown }).steps;
  return Array.isArray(steps)
    ? steps.filter(isSagaStepRecord)
    : [];
}

function readSagaId(state: AgentGraphState): string | undefined {
  const runtime = state.runtime as Record<string, unknown> | undefined;
  const saga = runtime?.saga;
  if (!saga || typeof saga !== 'object' || Array.isArray(saga)) {
    return undefined;
  }
  const sagaId = (saga as { saga_id?: unknown }).saga_id;
  return typeof sagaId === 'string' ? sagaId : undefined;
}

function upsertSagaStep(
  state: AgentGraphState,
  step: SagaStepRecord,
): AgentGraphState {
  const steps = [
    ...readSagaSteps(state).filter((item) => item.step_id !== step.step_id),
    step,
  ];
  return {
    ...state,
    runtime: {
      ...(state.runtime ?? {}),
      saga: {
        saga_id: step.saga_id,
        status: steps.some((item) => item.status === 'failed' || item.status === 'compensation_failed')
          ? 'failed'
          : steps.some((item) => item.status === 'pending')
            ? 'running'
            : 'completed',
        steps,
      },
    },
  };
}

function updateSagaStep(
  state: AgentGraphState,
  stepId: string,
  updater: (step: SagaStepRecord) => SagaStepRecord,
): AgentGraphState {
  const existing = readSagaSteps(state);
  const current = existing.find((step) => step.step_id === stepId);
  if (!current) {
    throw new ApiError('NOT_FOUND', `saga step not found: ${stepId}`);
  }
  return upsertSagaStep(state, updater(current));
}

function isSagaStepRecord(value: unknown): value is SagaStepRecord {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as SagaStepRecord).step_id === 'string' &&
    typeof (value as SagaStepRecord).tool_name === 'string',
  );
}
