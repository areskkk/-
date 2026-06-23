import { type AgentGraphState } from '../agents.types.js';
import { updateSagaCompensation } from './saga-orchestrator.js';
import { type ToolSemanticDefinition } from './tool-semantic-registry.js';

export type CompensationResult = {
  state: AgentGraphState;
  compensated: boolean;
  action?: string;
  reason: string;
};

export function runCompensationForFailedTool(input: {
  state: AgentGraphState;
  step_id: string;
  semantic: ToolSemanticDefinition;
  error_message: string;
}): CompensationResult {
  if (!input.semantic.compensatable) {
    return {
      state: input.state,
      compensated: false,
      reason: 'tool is not compensatable',
    };
  }
  if (input.semantic.irreversible) {
    return {
      state: updateSagaCompensation({
        state: input.state,
        step_id: input.step_id,
        status: 'failed',
        action: input.semantic.compensation_action,
        reason: 'irreversible tool cannot be compensated automatically',
      }),
      compensated: false,
      action: input.semantic.compensation_action,
      reason: 'irreversible tool cannot be compensated automatically',
    };
  }
  const action = input.semantic.compensation_action ?? `rollback:${input.semantic.tool_name}`;
  return {
    state: updateSagaCompensation({
      state: input.state,
      step_id: input.step_id,
      status: 'completed',
      action,
      reason: input.error_message,
    }),
    compensated: true,
    action,
    reason: input.error_message,
  };
}
