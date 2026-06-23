import { type AnyAgentToolDefinition, type AgentToolName } from './tool.types.js';
import { ragSearchTool } from './rag.tool.js';
import { materialEvidenceReadTool } from './material-read.tool.js';
import { eligibilityRuleEngineTool } from './eligibility.tool.js';

const tools = [
  ragSearchTool,
  materialEvidenceReadTool,
  eligibilityRuleEngineTool,
] as AnyAgentToolDefinition[];

const toolRegistry = new Map<AgentToolName, AnyAgentToolDefinition>(
  tools.map((tool) => [tool.name, tool]),
);

export function getAgentTool(
  name: AgentToolName,
): AnyAgentToolDefinition | null {
  return toolRegistry.get(name) ?? null;
}

export function listAgentTools(): AnyAgentToolDefinition[] {
  return [...toolRegistry.values()];
}
