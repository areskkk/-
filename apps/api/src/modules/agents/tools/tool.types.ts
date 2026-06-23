import { type AgentType } from '../../llm/model-registry.js';
import { type AgentRunEntrypoint, type AgentToolCallRow } from '../agents.types.js';

export type AgentToolName =
  | 'rag.search'
  | 'ocr.material_evidence.read'
  | 'eligibility.rule_engine.check';

export type AgentToolErrorType =
  | 'invalid_input'
  | 'permission_denied'
  | 'tool_not_found'
  | 'tool_not_allowed'
  | 'tool_limit_exceeded'
  | 'resource_not_found'
  | 'execution_failed';

export class AgentToolError extends Error {
  readonly type: AgentToolErrorType;
  readonly retryable: boolean;

  constructor(input: {
    type: AgentToolErrorType;
    message: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = 'AgentToolError';
    this.type = input.type;
    this.retryable = input.retryable ?? false;
  }
}

export type AgentToolContext = {
  run_id: string;
  actor_id: string;
  trace_id: string;
  agent_type: AgentType;
  entrypoint?: AgentRunEntrypoint;
  item_id?: string;
  roles?: string[];
  user_type?: string;
};

export type AgentToolExecutionResult<TOutput> = {
  tool_call: AgentToolCallRow;
  output: TOutput;
};

export type AgentToolDefinition<TInput, TOutput> = {
  name: AgentToolName;
  description: string;
  allowedAgents: AgentType[];
  parameters: Record<string, unknown>;
  validateInput: (input: unknown) => TInput;
  execute: (input: TInput, context: AgentToolContext) => Promise<TOutput>;
  summarizeOutput: (output: TOutput) => Record<string, unknown>;
};

export type AnyAgentToolDefinition = {
  name: AgentToolName;
  description: string;
  allowedAgents: AgentType[];
  parameters: Record<string, unknown>;
  validateInput: (input: unknown) => unknown;
  execute: (input: unknown, context: AgentToolContext) => Promise<unknown>;
  summarizeOutput: (output: unknown) => Record<string, unknown>;
};
