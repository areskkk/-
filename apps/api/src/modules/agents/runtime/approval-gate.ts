import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentGraphState } from '../agents.types.js';
import {
  buildDefaultOrchestrationContract,
  type OrchestrationContract,
  type SideEffectClass,
} from './orchestration-governance.js';

export type ApprovalRequest = {
  approval_id: string;
  status: 'pending' | 'approved' | 'rejected';
  side_effect_class: SideEffectClass;
  reason: string;
  requested_at: string;
  context: Record<string, unknown>;
};

export type ApprovalDecision = {
  approval_id: string;
  status: 'approved' | 'rejected';
  decided_by: string;
  decided_at: string;
  comment?: string;
};

export function classifyRuntimeSideEffect(input: {
  action: string;
  tool_name?: string;
}): SideEffectClass {
  if (input.action === 'respond_final') {
    return 'draft_only';
  }
  if (input.action === 'request_human') {
    return 'approval_required';
  }
  if (input.action === 'call_tool') {
    return 'read_only';
  }
  return 'none';
}

export function requireApprovalForSideEffect(input: {
  state: AgentGraphState;
  side_effect_class: SideEffectClass;
  reason: string;
  context?: Record<string, unknown>;
  contract?: OrchestrationContract;
}): AgentGraphState {
  const contract = input.contract ?? buildDefaultOrchestrationContract({
    phase: input.state.entrypoint,
  });
  const policy = contract.side_effect_policy[input.side_effect_class];
  if (!policy?.allowed) {
    throw new ApiError(
      'FORBIDDEN',
      `side effect ${input.side_effect_class} is not allowed by orchestration contract`,
    );
  }
  if (!policy.approval_required) {
    return input.state;
  }
  const approval: ApprovalRequest = {
    approval_id: randomUUID(),
    status: 'pending',
    side_effect_class: input.side_effect_class,
    reason: input.reason,
    requested_at: new Date().toISOString(),
    context: input.context ?? {},
  };
  return {
    ...input.state,
    control: {
      ...readControl(input.state),
      approval_requests: [
        ...readApprovalRequests(input.state),
        approval,
      ],
      interrupt_reason: input.reason,
    },
  };
}

export function resumeAfterApproval(input: {
  state: AgentGraphState;
  decision: ApprovalDecision;
}): AgentGraphState {
  const approvals = readApprovalRequests(input.state);
  const found = approvals.find(
    (approval) => approval.approval_id === input.decision.approval_id,
  );
  if (!found) {
    throw new ApiError('NOT_FOUND', 'approval request not found');
  }
  return {
    ...input.state,
    control: {
      ...readControl(input.state),
      approval_requests: approvals.map((approval) => (
        approval.approval_id === input.decision.approval_id
          ? {
              ...approval,
              status: input.decision.status,
              decided_by: input.decision.decided_by,
              decided_at: input.decision.decided_at,
              comment: input.decision.comment,
            }
          : approval
      )),
      manual_resume: input.decision.status === 'approved',
    },
  };
}

function readControl(state: AgentGraphState): Record<string, unknown> {
  const control = state.control;
  return control && typeof control === 'object' && !Array.isArray(control)
    ? control as Record<string, unknown>
    : {};
}

function readApprovalRequests(state: AgentGraphState): ApprovalRequest[] {
  const control = readControl(state);
  const requests = control.approval_requests;
  return Array.isArray(requests)
    ? requests.filter(isApprovalRequest)
    : [];
}

function isApprovalRequest(value: unknown): value is ApprovalRequest {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as ApprovalRequest).approval_id === 'string',
  );
}
