import { loadEnv } from '../../config/env.js';
import { queryOne } from '../../db/query.js';

export type AgentType =
  | 'supervisor'
  | 'retrieval_planner'
  | 'policy_analysis'
  | 'math_verification'
  | 'application_assist'
  | 'document_vision'
  | 'review'
  | 'risk_judge';

export type RegisteredModel = {
  agent_type: AgentType;
  model: string;
  provider: 'bailian';
  endpoint: string;
  model_version?: string | null;
  deployment_location?: string | null;
  finalization_record_id?: string | null;
};

export function getAgentModelRegistry(): Record<AgentType, RegisteredModel> {
  const env = loadEnv();

  return {
    supervisor: buildEntry('supervisor', env.agentModelSupervisor),
    retrieval_planner: buildEntry('retrieval_planner', env.agentModelRetrieval),
    policy_analysis: buildEntry('policy_analysis', env.agentModelPolicyAnalysis),
    math_verification: buildEntry('math_verification', env.agentModelMath),
    application_assist: buildEntry(
      'application_assist',
      env.agentModelApplicationAssist,
    ),
    document_vision: buildEntry('document_vision', env.agentModelDocumentVision),
    review: buildEntry('review', env.agentModelReview),
    risk_judge: buildEntry('risk_judge', env.agentModelRiskJudge),
  };
}

export function getModelForAgent(agentType: AgentType): RegisteredModel {
  return getAgentModelRegistry()[agentType];
}

export async function resolveModelForAgent(
  agentType: AgentType,
): Promise<RegisteredModel> {
  const active = await queryOne<{
    record_id: string;
    selected_model: string;
    endpoint: string;
    model_version: string | null;
    deployment_location: string | null;
  }>(
    `
      SELECT
        record_id::text,
        selected_model,
        endpoint,
        model_version,
        deployment_location
      FROM model_finalization_records
      WHERE agent_type = $1
        AND status = 'active'
      ORDER BY updated_at DESC, created_at DESC, record_id DESC
      LIMIT 1
    `,
    [agentType],
  );

  const model: RegisteredModel = !active ? getModelForAgent(agentType) : {
    agent_type: agentType,
    model: active.selected_model,
    provider: 'bailian',
    endpoint: active.endpoint,
    model_version: active.model_version,
    deployment_location: active.deployment_location,
    finalization_record_id: active.record_id,
  };
  return model;
}

function buildEntry(agentType: AgentType, model: string): RegisteredModel {
  return {
    agent_type: agentType,
    model,
    provider: 'bailian',
    endpoint: 'openai_compatible_chat_completions',
  };
}
