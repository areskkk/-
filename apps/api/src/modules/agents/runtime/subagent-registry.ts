import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentType } from '../../llm/model-registry.js';
import { type AgentToolName } from '../tools/tool.types.js';
import { type AgentAction } from './agent-action-schema.js';
import { type AgentPhase } from './phase-policy.js';

export type SubagentOutput =
  | DocumentVisionOutput
  | MathVerificationOutput
  | RiskJudgeOutput
  | PolicyAnalysisOutput
  | RetrievalPlannerOutput;

export type MathVerificationOutput = {
  verdict: 'pass' | 'fail' | 'unknown';
  explanation: string;
  checked_conditions?: unknown[];
  confidence: number;
};

export type RiskJudgeOutput = {
  approved: boolean;
  should_fallback: boolean;
  reasons?: string[];
  confidence: number;
};

export type DocumentVisionOutput = {
  risk_items: Array<{
    field: string;
    severity: 'low' | 'medium' | 'high';
    reason: string;
  }>;
  usable_as_hard_evidence: boolean;
  confidence: number;
};

export type PolicyAnalysisOutput = {
  result: string;
  matched_conditions?: unknown[];
  missing_fields?: unknown[];
  explanation: string;
  answer?: string;
  confidence: number;
};

export type RetrievalPlannerOutput = {
  query: string;
  policy_id?: string;
  limit?: number;
};

export type SubagentPermissionScope = {
  entrypoint: AgentPhase;
  item_id?: string;
  application_id?: string;
  policy_id?: string;
};

export type SubagentBudget = {
  max_subagents: number;
  max_turns_per_subagent: number;
  max_tool_calls_per_subagent: number;
  verifier_required: boolean;
};

export type SubagentDefinition = {
  agent_type: AgentType;
  role: 'coordinator' | 'worker' | 'verifier';
  phases: AgentPhase[];
  allowed_tools: AgentToolName[];
  output_contract:
    | 'retriever_result'
    | 'policy_analysis_result'
    | 'document_vision_result'
    | 'eligibility_explanation_result'
    | 'risk_verifier_result';
};

export type BoundSubagentScopeInput = {
  phase: AgentPhase;
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
};

export const DEFAULT_SUBAGENT_BUDGET: SubagentBudget = {
  max_subagents: 3,
  max_turns_per_subagent: 1,
  max_tool_calls_per_subagent: 0,
  verifier_required: true,
};

const PHASE_WORKER_SUBAGENTS: Record<AgentPhase, AgentType[]> = {
  consultation: ['retrieval_planner', 'policy_analysis'],
  application: ['document_vision', 'math_verification'],
  review: ['document_vision', 'math_verification'],
  mock_completed: [],
  mock_failed: [],
  mock_interrupted: [],
};

const PHASE_VERIFIERS: Record<AgentPhase, AgentType[]> = {
  consultation: ['risk_judge'],
  application: ['risk_judge'],
  review: ['risk_judge'],
  mock_completed: [],
  mock_failed: [],
  mock_interrupted: [],
};

const PHASE_COORDINATORS: Partial<Record<AgentPhase, AgentType>> = {
  consultation: 'supervisor',
  application: 'application_assist',
  review: 'review',
};

const SUBAGENT_DEFINITIONS: Record<AgentType, SubagentDefinition> = {
  supervisor: {
    agent_type: 'supervisor',
    role: 'coordinator',
    phases: ['consultation'],
    allowed_tools: [],
    output_contract: 'risk_verifier_result',
  },
  application_assist: {
    agent_type: 'application_assist',
    role: 'coordinator',
    phases: ['application'],
    allowed_tools: [],
    output_contract: 'risk_verifier_result',
  },
  review: {
    agent_type: 'review',
    role: 'coordinator',
    phases: ['review'],
    allowed_tools: [],
    output_contract: 'risk_verifier_result',
  },
  retrieval_planner: {
    agent_type: 'retrieval_planner',
    role: 'worker',
    phases: ['consultation'],
    allowed_tools: ['rag.search'],
    output_contract: 'retriever_result',
  },
  policy_analysis: {
    agent_type: 'policy_analysis',
    role: 'worker',
    phases: ['consultation'],
    allowed_tools: ['rag.search'],
    output_contract: 'policy_analysis_result',
  },
  document_vision: {
    agent_type: 'document_vision',
    role: 'worker',
    phases: ['application', 'review'],
    allowed_tools: ['ocr.material_evidence.read'],
    output_contract: 'document_vision_result',
  },
  math_verification: {
    agent_type: 'math_verification',
    role: 'worker',
    phases: ['application', 'review'],
    allowed_tools: [],
    output_contract: 'eligibility_explanation_result',
  },
  risk_judge: {
    agent_type: 'risk_judge',
    role: 'verifier',
    phases: ['consultation', 'application', 'review'],
    allowed_tools: [],
    output_contract: 'risk_verifier_result',
  },
};

export function getSubagentDefinition(
  agentType: AgentType,
): SubagentDefinition {
  return SUBAGENT_DEFINITIONS[agentType];
}

export function getCoordinatorAgent(phase: AgentPhase): AgentType | string {
  return PHASE_COORDINATORS[phase] ?? String(phase);
}

export function getAllowedSubagents(phase: AgentPhase): AgentType[] {
  return [
    ...PHASE_WORKER_SUBAGENTS[phase],
    ...PHASE_VERIFIERS[phase],
  ];
}

export function normalizeDelegatedSubagents(
  action: Extract<AgentAction, { action: 'delegate_subagent' }>,
  phase: AgentPhase,
): AgentType[] {
  const requested = action.subagents ?? (action.agent_type ? [action.agent_type] : []);
  const allowed = new Set<AgentType>(getAllowedSubagents(phase));
  const unique: AgentType[] = [];
  let verifierRequested = false;
  for (const agentType of requested) {
    if (!allowed.has(agentType)) {
      throw new ApiError('FORBIDDEN', `subagent ${agentType} is not allowed in ${phase}`);
    }
    if (SUBAGENT_DEFINITIONS[agentType].role === 'verifier') {
      verifierRequested = true;
      continue;
    }
    if (!unique.includes(agentType)) {
      unique.push(agentType);
    }
  }
  if (unique.length === 0 && !verifierRequested) {
    throw new ApiError('VALIDATION_ERROR', 'delegate_subagent requires at least one subagent');
  }
  return unique;
}

export function buildSubagentPermissionScope(
  input: BoundSubagentScopeInput,
): SubagentPermissionScope {
  if (input.phase === 'consultation') {
    return {
      entrypoint: input.phase,
      policy_id: input.policy_id,
    };
  }
  if (input.phase === 'application') {
    if (!input.application) {
      throw new ApiError('VALIDATION_ERROR', 'application tool scope is required');
    }
    return {
      entrypoint: input.phase,
      item_id: input.application.item_id,
      application_id: input.application.application_id,
      policy_id: input.application.policy_id,
    };
  }
  if (input.phase === 'review') {
    if (!input.review) {
      throw new ApiError('VALIDATION_ERROR', 'review tool scope is required');
    }
    return {
      entrypoint: input.phase,
      item_id: input.review.item_id,
      application_id: input.review.application_id,
      policy_id: input.review.policy_id,
    };
  }
  throw new ApiError('FORBIDDEN', `delegate_subagent is not enabled in ${input.phase}`);
}

export function assertSubagentPermission(
  scope: SubagentPermissionScope,
  agentType: AgentType,
): void {
  const definition = SUBAGENT_DEFINITIONS[agentType];
  if (!definition || definition.role === 'coordinator') {
    throw new ApiError('FORBIDDEN', `subagent ${agentType} is not supported`);
  }
  if (!getAllowedSubagents(scope.entrypoint).includes(agentType)) {
    throw new ApiError('FORBIDDEN', `subagent ${agentType} is not allowed in ${scope.entrypoint} scope`);
  }
  if (!definition.phases.includes(scope.entrypoint)) {
    throw new ApiError('FORBIDDEN', `subagent ${agentType} is not registered for ${scope.entrypoint}`);
  }
  if (scope.entrypoint === 'consultation') {
    return;
  }
  if (!scope.item_id || !scope.application_id) {
    throw new ApiError(
      'FORBIDDEN',
      `${scope.entrypoint} subagent requires bound application item scope`,
    );
  }
}
