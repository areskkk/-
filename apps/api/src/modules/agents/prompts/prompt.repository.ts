import { queryOne } from '../../../db/query.js';
import { type AgentType } from '../../llm/model-registry.js';

export type ActivePromptTemplate = {
  template_id: string;
  agent_type: AgentType;
  version: string;
  status: string;
  content: string;
};

export async function findActivePromptTemplate(
  agentType: AgentType,
): Promise<ActivePromptTemplate | undefined> {
  return queryOne<ActivePromptTemplate>(
    `
      SELECT
        template_id::text,
        agent_type,
        version,
        status,
        content
      FROM prompt_templates
      WHERE agent_type = $1
        AND status = 'active'
      ORDER BY updated_at DESC, created_at DESC, template_id DESC
      LIMIT 1
    `,
    [agentType],
  );
}
