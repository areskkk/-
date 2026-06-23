import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentGraphState } from '../agents.types.js';
import { type OrchestrationContract, assertCrossDomainAllowed } from './orchestration-governance.js';
import { type AgentPhase } from './phase-policy.js';
import {
  buildSubagentPermissionScope,
  type BoundSubagentScopeInput,
  type SubagentPermissionScope,
} from './subagent-registry.js';

export type RuntimeToolScope = {
  policy_id?: string;
  application?: {
    item_id: string;
    application_id: string;
    policy_id: string;
  };
  review?: {
    item_id: string;
    application_id: string;
    policy_id: string;
  };
  manual_resume?: unknown;
};

export type CrossDomainRoute = {
  from_phase: AgentPhase;
  target_phase: AgentPhase;
  permission_scope: SubagentPermissionScope;
  tool_scope: RuntimeToolScope;
  context: Record<string, unknown>;
  boundaries: OrchestrationContract['cross_domain'];
};

export function buildCrossDomainRoute(input: {
  state: AgentGraphState;
  from_phase: AgentPhase;
  target_phase: AgentPhase;
  contract: OrchestrationContract;
  tool_scope: RuntimeToolScope;
}): CrossDomainRoute {
  assertCrossDomainAllowed({
    contract: input.contract,
    from_phase: input.from_phase,
    target_phase: input.target_phase,
  });
  const toolScope = resolveTargetToolScope(input);
  const permissionScope = buildSubagentPermissionScope({
    phase: input.target_phase,
    policy_id: toolScope.policy_id,
    application: toolScope.application,
    review: toolScope.review,
  } satisfies BoundSubagentScopeInput);
  return {
    from_phase: input.from_phase,
    target_phase: input.target_phase,
    permission_scope: permissionScope,
    tool_scope: toolScope,
    context: {
      source_phase: input.from_phase,
      target_phase: input.target_phase,
      source_context_readonly: true,
      target_phase_draft_only: true,
      input: input.state.input,
    },
    boundaries: input.contract.cross_domain,
  };
}

function resolveTargetToolScope(input: {
  state: AgentGraphState;
  from_phase: AgentPhase;
  target_phase: AgentPhase;
  tool_scope: RuntimeToolScope;
}): RuntimeToolScope {
  if (input.from_phase === input.target_phase) {
    return input.tool_scope;
  }
  if (input.target_phase === 'consultation') {
    const policyId = readString(input.state.input.policy_id) ?? input.tool_scope.policy_id;
    if (!policyId) {
      throw new ApiError('VALIDATION_ERROR', 'cross-domain consultation target requires policy_id');
    }
    return {
      ...input.tool_scope,
      policy_id: policyId,
    };
  }
  if (input.target_phase === 'application') {
    const application = input.tool_scope.application ?? readApplicationScope(input.state);
    if (!application) {
      throw new ApiError('VALIDATION_ERROR', 'cross-domain application target requires application context');
    }
    return {
      ...input.tool_scope,
      application,
    };
  }
  if (input.target_phase === 'review') {
    const review = input.tool_scope.review ?? readReviewScope(input.state);
    if (!review) {
      throw new ApiError('VALIDATION_ERROR', 'cross-domain review target requires review context');
    }
    return {
      ...input.tool_scope,
      review,
    };
  }
  throw new ApiError('FORBIDDEN', `cross-domain target ${input.target_phase} is not supported`);
}

function readApplicationScope(state: AgentGraphState): RuntimeToolScope['application'] | undefined {
  const itemId = readString(state.input.item_id);
  const applicationId = readString(state.input.application_id);
  const policyId = readString(state.input.policy_id);
  if (!itemId || !applicationId || !policyId) {
    return undefined;
  }
  return {
    item_id: itemId,
    application_id: applicationId,
    policy_id: policyId,
  };
}

function readReviewScope(state: AgentGraphState): RuntimeToolScope['review'] | undefined {
  const itemId = readString(state.input.item_id);
  const applicationId = readString(state.input.application_id);
  const policyId = readString(state.input.policy_id);
  if (!itemId || !applicationId || !policyId) {
    return undefined;
  }
  return {
    item_id: itemId,
    application_id: applicationId,
    policy_id: policyId,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}
