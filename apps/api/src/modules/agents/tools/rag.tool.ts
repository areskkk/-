import { ragService } from '../../rag/rag.service.js';
import { type RagSearchResult } from '../../rag/rag.types.js';
import {
  AgentToolError,
  type AgentToolContext,
  type AgentToolDefinition,
} from './tool.types.js';

type RagSearchToolInput = {
  query: string;
  policy_id?: string;
  limit: number;
  create_fallback_task: boolean;
};

export const ragSearchTool: AgentToolDefinition<
  RagSearchToolInput,
  RagSearchResult
> = {
  name: 'rag.search',
  description: 'Search policy knowledge chunks and return citations.',
  allowedAgents: ['retrieval_planner', 'policy_analysis'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'Policy question or retrieval query.',
      },
    },
  },
  validateInput(input) {
    const value = assertRecord(input);
    const query = assertNonEmptyString(value.query, 'query');
    const policyId = optionalString(value.policy_id, 'policy_id');
    const limit = optionalPositiveInteger(value.limit, 'limit') ?? 3;
    return {
      query,
      policy_id: policyId,
      limit,
      create_fallback_task: value.create_fallback_task === true,
    };
  },
  execute(input: RagSearchToolInput, context: AgentToolContext) {
    return ragService.search(context.actor_id, context.trace_id, input);
  },
  summarizeOutput(output) {
    return {
      status: output.status,
      confidence: output.confidence,
      backend_mode: output.backend_mode,
      citation_count: output.citations.length,
      degrade_reason: output.degrade_reason ?? null,
    };
  },
};

function assertRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentToolError({
      type: 'invalid_input',
      message: 'tool input must be an object',
    });
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentToolError({
      type: 'invalid_input',
      message: `${field} is required`,
    });
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new AgentToolError({
      type: 'invalid_input',
      message: `${field} must be a string`,
    });
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AgentToolError({
      type: 'invalid_input',
      message: `${field} must be a positive integer`,
    });
  }
  return value;
}
