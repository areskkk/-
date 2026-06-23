import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentToolName } from '../tools/tool.types.js';
import { type OrchestrationContract, type SideEffectClass } from './orchestration-governance.js';

export type ToolSemanticClass =
  | 'read_only'
  | 'draft_only'
  | 'approval_required'
  | 'external_mutation';

export type ToolSemanticDefinition = {
  tool_name: AgentToolName;
  semantic_class: ToolSemanticClass;
  side_effect_class: SideEffectClass;
  idempotent: boolean;
  compensatable: boolean;
  irreversible: boolean;
  compensation_action?: string;
};

export type ToolSemanticDecision = {
  tool_name: AgentToolName;
  semantic_class: ToolSemanticClass;
  side_effect_class: SideEffectClass;
  allowed: boolean;
  approval_required: boolean;
  compensation_required: boolean;
  idempotent: boolean;
  compensatable: boolean;
  irreversible: boolean;
  reason: string;
};

const TOOL_SEMANTICS: Record<AgentToolName, ToolSemanticDefinition> = {
  'rag.search': {
    tool_name: 'rag.search',
    semantic_class: 'read_only',
    side_effect_class: 'read_only',
    idempotent: true,
    compensatable: false,
    irreversible: false,
  },
  'ocr.material_evidence.read': {
    tool_name: 'ocr.material_evidence.read',
    semantic_class: 'read_only',
    side_effect_class: 'read_only',
    idempotent: true,
    compensatable: false,
    irreversible: false,
  },
  'eligibility.rule_engine.check': {
    tool_name: 'eligibility.rule_engine.check',
    semantic_class: 'read_only',
    side_effect_class: 'read_only',
    idempotent: true,
    compensatable: false,
    irreversible: false,
  },
};

export function getToolSemanticDefinition(
  toolName: AgentToolName,
): ToolSemanticDefinition {
  return TOOL_SEMANTICS[toolName];
}

export function requireToolSemanticDefinition(
  toolName: AgentToolName,
): ToolSemanticDefinition {
  const definition = getToolSemanticDefinition(toolName);
  if (!definition) {
    throw new ApiError('FORBIDDEN', `tool semantic is not registered: ${toolName}`);
  }
  return definition;
}

export function decideToolSideEffect(input: {
  tool_name: AgentToolName;
  contract: OrchestrationContract;
  semantic?: ToolSemanticDefinition;
}): ToolSemanticDecision {
  const semantic = input.semantic ?? requireToolSemanticDefinition(input.tool_name);
  const policy = input.contract.side_effect_policy[semantic.side_effect_class];
  if (!policy?.allowed) {
    return {
      ...toDecisionBase(semantic),
      allowed: false,
      approval_required: policy?.approval_required ?? true,
      compensation_required: false,
      reason: `side effect ${semantic.side_effect_class} is not allowed`,
    };
  }
  return {
    ...toDecisionBase(semantic),
    allowed: true,
    approval_required: policy.approval_required || semantic.semantic_class === 'approval_required',
    compensation_required: semantic.compensatable && semantic.side_effect_class !== 'read_only',
    reason: semantic.irreversible
      ? 'irreversible tool requires explicit governance'
      : 'tool semantic accepted',
  };
}

function toDecisionBase(
  semantic: ToolSemanticDefinition,
): Omit<ToolSemanticDecision, 'allowed' | 'approval_required' | 'compensation_required' | 'reason'> {
  return {
    tool_name: semantic.tool_name,
    semantic_class: semantic.semantic_class,
    side_effect_class: semantic.side_effect_class,
    idempotent: semantic.idempotent,
    compensatable: semantic.compensatable,
    irreversible: semantic.irreversible,
  };
}
