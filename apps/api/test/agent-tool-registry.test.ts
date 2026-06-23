import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { listAgentTools, getAgentTool } from '../src/modules/agents/tools/tool-registry.js';
import { AgentToolError } from '../src/modules/agents/tools/tool.types.js';

describe('agent tool registry', () => {
  it('registers the production graph tools with allowed agents', () => {
    const tools = listAgentTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'eligibility.rule_engine.check',
      'ocr.material_evidence.read',
      'rag.search',
    ]);
    expect(getAgentTool('rag.search')?.allowedAgents).toContain('retrieval_planner');
    expect(getAgentTool('eligibility.rule_engine.check')?.allowedAgents).toContain('review');
  });

  it('validates rag search input before execution', () => {
    const tool = getAgentTool('rag.search');

    expect(tool?.validateInput({
      query: '稳岗补贴',
      policy_id: '',
      limit: 2,
    })).toEqual({
      query: '稳岗补贴',
      policy_id: undefined,
      limit: 2,
      create_fallback_task: false,
    });
    expect(() => tool?.validateInput({ query: '', limit: 0 }))
      .toThrow(AgentToolError);
  });

  it('validates eligibility input before execution', () => {
    const tool = getAgentTool('eligibility.rule_engine.check');

    expect(() => tool?.validateInput({
      application_id: 'app-1',
      item_id: 'item-1',
      enterprise_id: 'ent-1',
      policy_id: 'policy-1',
    })).toThrow(AgentToolError);
  });

  it('keeps review document vision on summary material evidence', () => {
    const source = readFileSync(
      'src/modules/agents/runtime/review-graph-runner.ts',
      'utf-8',
    );

    expect(source).toContain("mode: 'summary'");
    expect(source).toContain("agent_type: 'document_vision'");
    expect(source).not.toContain('mode: \'full\'');
  });
});
