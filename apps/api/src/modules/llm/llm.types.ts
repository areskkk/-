export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export type LlmToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type LlmMessage = {
  role: LlmRole;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: LlmToolCall[];
};

export type LlmTokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type LlmErrorType =
  | 'configuration'
  | 'authentication'
  | 'rate_limit'
  | 'local_circuit_open'
  | 'timeout'
  | 'server'
  | 'network'
  | 'invalid_response';

export type LlmChatRequest = {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  response_format?: 'json_object' | 'text';
  tools?: LlmToolDefinition[];
  tool_choice?: 'auto' | 'none';
  timeout_ms?: number;
  max_retries?: number;
  trace_id?: string;
  run_id?: string;
  agent_type?: string;
  prompt_version?: string;
  estimated_max_tokens?: number;
};

export type LlmChatResponse<TJson = unknown> = {
  provider: string;
  model: string;
  content: string;
  json: TJson | null;
  tool_calls?: LlmToolCall[];
  usage: LlmTokenUsage | null;
  raw: unknown;
};

export type LlmToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export interface LlmClient {
  chatCompletion<TJson = unknown>(
    request: LlmChatRequest,
  ): Promise<LlmChatResponse<TJson>>;
}

export class LlmError extends Error {
  readonly type: LlmErrorType;
  readonly status?: number;
  readonly retryable: boolean;
  readonly provider: string;
  readonly model?: string;
  readonly trace_id?: string;

  constructor(input: {
    type: LlmErrorType;
    message: string;
    retryable: boolean;
    provider: string;
    status?: number;
    model?: string;
    trace_id?: string;
  }) {
    super(input.message);
    this.name = 'LlmError';
    this.type = input.type;
    this.status = input.status;
    this.retryable = input.retryable;
    this.provider = input.provider;
    this.model = input.model;
    this.trace_id = input.trace_id;
  }
}
