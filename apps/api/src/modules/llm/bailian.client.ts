import { loadEnv } from '../../config/env.js';
import { parseLlmJson } from './llm-json.js';
import {
  LlmError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmClient,
  type LlmTokenUsage,
  type LlmToolCall,
} from './llm.types.js';

type BailianChatChoice = {
  message?: {
    content?: unknown;
    tool_calls?: unknown;
  };
};

type BailianChatResponse = {
  choices?: BailianChatChoice[];
  usage?: Partial<LlmTokenUsage>;
};

const PROVIDER = 'bailian';

export class BailianLlmClient implements LlmClient {
  async chatCompletion<TJson = unknown>(
    request: LlmChatRequest,
  ): Promise<LlmChatResponse<TJson>> {
    const env = loadEnv();
    if (!env.bailianApiKey) {
      throw new LlmError({
        type: 'configuration',
        message: 'BAILIAN_API_KEY is not configured',
        retryable: false,
        provider: PROVIDER,
        model: request.model,
        trace_id: request.trace_id,
      });
    }

    const maxRetries = request.max_retries ?? env.agentLlmMaxRetries;
    let attempt = 0;
    let lastError: LlmError | null = null;

    while (attempt <= maxRetries) {
      try {
        return await this.postChatCompletion<TJson>(request, env);
      } catch (error) {
        const classified = toLlmError(error, request);
        lastError = classified;
        if (!classified.retryable || attempt >= maxRetries) {
          throw classified;
        }
        await sleep(backoffMs(attempt));
      }
      attempt += 1;
    }

    throw lastError ?? new LlmError({
      type: 'network',
      message: 'llm request failed',
      retryable: true,
      provider: PROVIDER,
      model: request.model,
      trace_id: request.trace_id,
    });
  }

  private async postChatCompletion<TJson>(
    request: LlmChatRequest,
    env: ReturnType<typeof loadEnv>,
  ): Promise<LlmChatResponse<TJson>> {
    const timeoutMs = request.timeout_ms ?? env.agentLlmTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(buildChatCompletionsUrl(env.bailianBaseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.bailianApiKey}`,
          'content-type': 'application/json',
          connection: 'close',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? env.agentDefaultTemperature,
          max_tokens: request.estimated_max_tokens ?? env.agentLlmEstimatedMaxTokens,
          tools: request.tools,
          tool_choice: request.tools?.length ? request.tool_choice ?? 'auto' : undefined,
          response_format:
            request.response_format === 'json_object'
              ? { type: 'json_object' }
              : undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new LlmError({
          type: classifyHttpStatus(response.status),
          message: `llm request failed with status ${response.status}`,
          retryable: isRetryableStatus(response.status),
          provider: PROVIDER,
          status: response.status,
          model: request.model,
          trace_id: request.trace_id,
        });
      }

      const payload = await safeReadJson(response, request);
      const content = readAssistantContent(payload, request);
      const toolCalls = readToolCalls(payload);
      const usage = readUsage(payload);

      return {
        provider: PROVIDER,
        model: request.model,
        content,
        json:
          request.response_format === 'json_object' && content.trim() !== ''
            ? parseLlmJson<TJson>(content, {
              provider: PROVIDER,
              model: request.model,
              trace_id: request.trace_id,
            })
            : null,
        tool_calls: toolCalls,
        usage,
        raw: payload,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LlmError({
          type: 'timeout',
          message: 'llm request timed out',
          retryable: true,
          provider: PROVIDER,
          model: request.model,
          trace_id: request.trace_id,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

async function safeReadJson(
  response: Response,
  request: LlmChatRequest,
): Promise<BailianChatResponse> {
  try {
    return (await response.json()) as BailianChatResponse;
  } catch {
    throw new LlmError({
      type: 'invalid_response',
      message: 'llm returned non-json response',
      retryable: false,
      provider: PROVIDER,
      model: request.model,
      trace_id: request.trace_id,
    });
  }
}

function readAssistantContent(
  payload: BailianChatResponse,
  request: LlmChatRequest,
): string {
  const message = payload.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content !== 'string') {
    if (Array.isArray(message?.tool_calls)) {
      return '';
    }
    throw new LlmError({
      type: 'invalid_response',
      message: 'llm response missing assistant content',
      retryable: false,
      provider: PROVIDER,
      model: request.model,
      trace_id: request.trace_id,
    });
  }
  return content;
}

function readToolCalls(payload: BailianChatResponse): LlmToolCall[] {
  const toolCalls = payload.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.flatMap((call, index) => {
    if (!call || typeof call !== 'object') {
      return [];
    }
    const value = call as Record<string, unknown>;
    const fn = value.function;
    if (!fn || typeof fn !== 'object') {
      return [];
    }
    const functionValue = fn as Record<string, unknown>;
    const name = functionValue.name;
    const args = functionValue.arguments;
    if (typeof name !== 'string') {
      return [];
    }
    return [{
      id: typeof value.id === 'string' ? value.id : `tool_call_${index}`,
      type: 'function' as const,
      function: {
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    }];
  });
}

function readUsage(payload: BailianChatResponse): LlmTokenUsage | null {
  const usage = payload.usage;
  if (!usage) {
    return null;
  }

  return {
    prompt_tokens: Number(usage.prompt_tokens ?? 0),
    completion_tokens: Number(usage.completion_tokens ?? 0),
    total_tokens: Number(usage.total_tokens ?? 0),
  };
}

function classifyHttpStatus(status: number): 'authentication' | 'rate_limit' | 'server' | 'invalid_response' {
  if (status === 401 || status === 403) {
    return 'authentication';
  }
  if (status === 429) {
    return 'rate_limit';
  }
  if (status >= 500) {
    return 'server';
  }
  return 'invalid_response';
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function toLlmError(error: unknown, request: LlmChatRequest): LlmError {
  if (error instanceof LlmError) {
    return error;
  }

  return new LlmError({
    type: 'network',
    message: 'llm network request failed',
    retryable: true,
    provider: PROVIDER,
    model: request.model,
    trace_id: request.trace_id,
  });
}

function backoffMs(attempt: number): number {
  return 100 * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('chat/completions', normalizedBaseUrl).toString();
}

export const bailianLlmClient = new BailianLlmClient();
