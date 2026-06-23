import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentType } from '../../llm/model-registry.js';
import { type AgentToolName } from '../tools/tool.types.js';
import { type AgentRunEntrypoint } from '../agents.types.js';
import { type AgentAction, type AgentActionType } from './agent-action-schema.js';
import { getAllowedSubagents } from './subagent-registry.js';

export type AgentPhase = AgentRunEntrypoint;

type PhasePolicy = {
  agents: AgentType[];
  actions: AgentActionType[];
  tools: AgentToolName[];
};

const PHASE_POLICIES: Record<AgentPhase, PhasePolicy> = {
  consultation: {
    agents: ['supervisor', 'retrieval_planner', 'policy_analysis', 'risk_judge'],
    actions: ['call_tool', 'delegate_subagent', 'respond_final', 'request_human', 'update_plan', 'stop_run'],
    tools: ['rag.search'],
  },
  application: {
    agents: ['application_assist', 'document_vision', 'math_verification', 'risk_judge'],
    actions: ['call_tool', 'delegate_subagent', 'respond_final', 'request_human', 'update_plan', 'stop_run'],
    tools: ['ocr.material_evidence.read', 'eligibility.rule_engine.check'],
  },
  review: {
    agents: ['review', 'document_vision', 'math_verification', 'risk_judge'],
    actions: ['call_tool', 'delegate_subagent', 'respond_final', 'request_human', 'update_plan', 'stop_run'],
    tools: ['ocr.material_evidence.read', 'eligibility.rule_engine.check'],
  },
  mock_completed: {
    agents: [],
    actions: [],
    tools: [],
  },
  mock_failed: {
    agents: [],
    actions: [],
    tools: [],
  },
  mock_interrupted: {
    agents: [],
    actions: [],
    tools: [],
  },
};

export function getPhasePolicy(phase: AgentPhase): PhasePolicy {
  return PHASE_POLICIES[phase];
}

export function assertPhaseAgentAllowed(input: {
  phase: AgentPhase;
  agent_type: AgentType;
}): void {
  if (!getPhasePolicy(input.phase).agents.includes(input.agent_type)) {
    throw new ApiError('FORBIDDEN', `agent ${input.agent_type} is not allowed in ${input.phase}`);
  }
}

export function assertPhaseActionAllowed(input: {
  phase: AgentPhase;
  action: AgentAction;
}): void {
  const policy = getPhasePolicy(input.phase);
  if (!policy.actions.includes(input.action.action)) {
    throw new ApiError('FORBIDDEN', `action ${input.action.action} is not allowed in ${input.phase}`);
  }
  if (
    input.action.action === 'call_tool' &&
    !policy.tools.includes(input.action.tool_name)
  ) {
    throw new ApiError(
      'FORBIDDEN',
      `tool ${input.action.tool_name} is not allowed in ${input.phase}`,
    );
  }
  if (input.action.action === 'delegate_subagent') {
    const targetPhase = input.action.target_phase ?? input.phase;
    const delegated = input.action.subagents ?? (
      input.action.agent_type ? [input.action.agent_type] : []
    );
    if (delegated.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'delegate_subagent requires at least one subagent');
    }
    const allowedSubagents = getAllowedSubagents(targetPhase);
    for (const agentType of delegated) {
      if (
        !allowedSubagents.includes(agentType) ||
        ['supervisor', 'application_assist', 'review'].includes(agentType)
      ) {
        throw new ApiError(
          'FORBIDDEN',
          `subagent ${agentType} is not allowed in ${targetPhase}`,
        );
      }
    }
  }
}
