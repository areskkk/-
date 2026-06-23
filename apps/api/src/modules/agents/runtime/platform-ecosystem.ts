import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentType } from '../../llm/model-registry.js';
import { listAgentTools } from '../tools/tool-registry.js';
import { type AgentToolName } from '../tools/tool.types.js';
import { getSubagentDefinition } from './subagent-registry.js';
import { requireToolSemanticDefinition } from './tool-semantic-registry.js';

export type TenantPolicy = {
  tenant_id: string;
  allowed_agents: AgentType[];
  allowed_tools: AgentToolName[];
  max_parallel_subagents: number;
  plugin_allowlist: string[];
};

export type CapabilityDescriptor = {
  capability_id: string;
  kind: 'agent' | 'tool';
  name: string;
  description: string;
  allowed: boolean;
  side_effect_class?: string;
  output_contract?: string;
};

export type PluginDescriptor = {
  plugin_id: string;
  version: string;
  capabilities: string[];
  enabled: boolean;
  sandbox: {
    network: 'none' | 'restricted';
    filesystem: 'none';
    side_effects: 'registry_declared_only';
  };
};

const CORE_PLUGINS: PluginDescriptor[] = [{
  plugin_id: 'core.agent-runtime',
  version: '1.0.0',
  capabilities: [
    'agent:retrieval_planner',
    'agent:policy_analysis',
    'agent:document_vision',
    'agent:math_verification',
    'agent:risk_judge',
    'tool:rag.search',
    'tool:ocr.material_evidence.read',
    'tool:eligibility.rule_engine.check',
  ],
  enabled: true,
  sandbox: {
    network: 'restricted',
    filesystem: 'none',
    side_effects: 'registry_declared_only',
  },
}];

const DEFAULT_TENANT_POLICY: TenantPolicy = {
  tenant_id: 'default',
  allowed_agents: [
    'retrieval_planner',
    'policy_analysis',
    'document_vision',
    'math_verification',
    'risk_judge',
  ],
  allowed_tools: [
    'rag.search',
    'ocr.material_evidence.read',
    'eligibility.rule_engine.check',
  ],
  max_parallel_subagents: 4,
  plugin_allowlist: ['core.agent-runtime'],
};

export function buildTenantPolicy(input?: Partial<TenantPolicy>): TenantPolicy {
  return {
    ...DEFAULT_TENANT_POLICY,
    ...(input ?? {}),
    tenant_id: input?.tenant_id ?? DEFAULT_TENANT_POLICY.tenant_id,
    max_parallel_subagents: input?.max_parallel_subagents
      ?? DEFAULT_TENANT_POLICY.max_parallel_subagents,
    allowed_agents: input?.allowed_agents ?? DEFAULT_TENANT_POLICY.allowed_agents,
    allowed_tools: input?.allowed_tools ?? DEFAULT_TENANT_POLICY.allowed_tools,
    plugin_allowlist: input?.plugin_allowlist ?? DEFAULT_TENANT_POLICY.plugin_allowlist,
  };
}

export function assertTenantCapabilityAllowed(input: {
  tenant: TenantPolicy;
  agent_type?: AgentType;
  tool_name?: AgentToolName;
  plugin_id?: string;
}): void {
  if (input.agent_type && !input.tenant.allowed_agents.includes(input.agent_type)) {
    throw new ApiError('FORBIDDEN', `tenant ${input.tenant.tenant_id} cannot use agent ${input.agent_type}`);
  }
  if (input.tool_name && !input.tenant.allowed_tools.includes(input.tool_name)) {
    throw new ApiError('FORBIDDEN', `tenant ${input.tenant.tenant_id} cannot use tool ${input.tool_name}`);
  }
  if (input.plugin_id && !input.tenant.plugin_allowlist.includes(input.plugin_id)) {
    throw new ApiError('FORBIDDEN', `tenant ${input.tenant.tenant_id} cannot use plugin ${input.plugin_id}`);
  }
}

export function discoverCapabilities(input?: {
  tenant?: TenantPolicy;
}): CapabilityDescriptor[] {
  const tenant = input?.tenant ?? DEFAULT_TENANT_POLICY;
  const agents: AgentType[] = [
    'retrieval_planner',
    'policy_analysis',
    'document_vision',
    'math_verification',
    'risk_judge',
  ];
  const agentCapabilities = agents.map((agentType) => {
    const definition = getSubagentDefinition(agentType);
    return {
      capability_id: `agent:${agentType}`,
      kind: 'agent' as const,
      name: agentType,
      description: `${agentType} subagent`,
      allowed: tenant.allowed_agents.includes(agentType),
      output_contract: definition.output_contract,
    };
  });
  const toolCapabilities = listAgentTools().map((tool) => {
    const semantic = requireToolSemanticDefinition(tool.name);
    return {
      capability_id: `tool:${tool.name}`,
      kind: 'tool' as const,
      name: tool.name,
      description: tool.description,
      allowed: tenant.allowed_tools.includes(tool.name),
      side_effect_class: semantic.side_effect_class,
    };
  });
  return [
    ...agentCapabilities,
    ...toolCapabilities,
  ];
}

export function listPluginRegistry(input?: {
  tenant?: TenantPolicy;
}): PluginDescriptor[] {
  const tenant = input?.tenant ?? DEFAULT_TENANT_POLICY;
  return CORE_PLUGINS.map((plugin) => ({
    ...plugin,
    enabled: plugin.enabled && tenant.plugin_allowlist.includes(plugin.plugin_id),
  }));
}
