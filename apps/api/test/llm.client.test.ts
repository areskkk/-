import { afterEach, describe, expect, it, vi } from 'vitest';
import { BailianLlmClient } from '../src/modules/llm/bailian.client.js';
import { FakeLlmClient } from '../src/modules/llm/fake-llm.client.js';
import { LlmError } from '../src/modules/llm/llm.types.js';
import {
  getAgentModelRegistry,
  getModelForAgent,
} from '../src/modules/llm/model-registry.js';

const originalEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('LLM infrastructure', () => {
  it('runs with fake provider and parses json output', async () => {
    const client = new FakeLlmClient([{
      content: '```json\n{"intent":"consultation","confidence":0.91}\n```',
      usage: {
        prompt_tokens: 8,
        completion_tokens: 4,
        total_tokens: 12,
      },
    }]);

    const response = await client.chatCompletion<{
      intent: string;
      confidence: number;
    }>({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      response_format: 'json_object',
    });

    expect(response.provider).toBe('fake');
    expect(response.json).toEqual({
      intent: 'consultation',
      confidence: 0.91,
    });
    expect(response.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 4,
      total_tokens: 12,
    });
    expect(client.getCallCount()).toBe(1);
  });

  it('calls Bailian OpenAI-compatible chat completions and records token usage', async () => {
    process.env.BAILIAN_API_KEY = 'test-secret-key';
    process.env.BAILIAN_BASE_URL = 'https://example.test/compatible-mode/v1';
    process.env.AGENT_LLM_MAX_RETRIES = '1';

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await new BailianLlmClient().chatCompletion<{ ok: boolean }>({
      model: 'qwen-plus-2025-07-28',
      messages: [{ role: 'user', content: 'return json' }],
      response_format: 'json_object',
      trace_id: 'trace-llm-test',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://example.test/compatible-mode/v1/chat/completions',
    );
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer test-secret-key');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).max_tokens).toBe(4096);
    expect(response.json).toEqual({ ok: true });
    expect(response.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });
  });

  it('sends explicit max_tokens when estimated_max_tokens is set', async () => {
    process.env.BAILIAN_API_KEY = 'test-secret-key';
    process.env.BAILIAN_BASE_URL = 'https://example.test/compatible-mode/v1';

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'ok' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await new BailianLlmClient().chatCompletion({
      model: 'qwen-plus-2025-07-28',
      messages: [{ role: 'user', content: 'hello' }],
      estimated_max_tokens: 123,
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).max_tokens).toBe(123);
  });

  it('sends tools and parses assistant tool calls', async () => {
    process.env.BAILIAN_API_KEY = 'test-secret-key';
    process.env.BAILIAN_BASE_URL = 'https://example.test/compatible-mode/v1';

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{
        message: {
          tool_calls: [{
            id: 'call-rag-1',
            type: 'function',
            function: {
              name: 'rag.search',
              arguments: '{"query":"stable subsidy","limit":3}',
            },
          }],
        },
      }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 8,
        total_tokens: 28,
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await new BailianLlmClient().chatCompletion({
      model: 'qwen-plus-2025-07-28',
      messages: [{ role: 'user', content: 'search policy' }],
      tools: [{
        type: 'function',
        function: {
          name: 'rag.search',
          description: 'Search policy chunks.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      }],
      tool_choice: 'auto',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.tools[0].function.name).toBe('rag.search');
    expect(body.tool_choice).toBe('auto');
    expect(response.content).toBe('');
    expect(response.tool_calls?.[0]).toMatchObject({
      id: 'call-rag-1',
      function: {
        name: 'rag.search',
        arguments: '{"query":"stable subsidy","limit":3}',
      },
    });
  });

  it('retries retryable server errors', async () => {
    process.env.BAILIAN_API_KEY = 'test-secret-key';
    process.env.AGENT_LLM_MAX_RETRIES = '1';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'temporary' }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await new BailianLlmClient().chatCompletion({
      model: 'qwen-plus-2025-07-28',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.content).toBe('ok');
  });

  it('classifies auth error without leaking API key in error message', async () => {
    process.env.BAILIAN_API_KEY = 'super-secret-key';
    process.env.AGENT_LLM_MAX_RETRIES = '1';

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: 'bad key super-secret-key' }, { status: 401 }),
    ));

    await expect(new BailianLlmClient().chatCompletion({
      model: 'qwen-plus-2025-07-28',
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({
      type: 'authentication',
      retryable: false,
      status: 401,
    });

    try {
      await new BailianLlmClient().chatCompletion({
        model: 'qwen-plus-2025-07-28',
        messages: [{ role: 'user', content: 'hello' }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as Error).message).not.toContain('super-secret-key');
    }
  });

  it('classifies timeout errors', async () => {
    process.env.BAILIAN_API_KEY = 'test-secret-key';
    process.env.AGENT_LLM_MAX_RETRIES = '0';

    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    })));

    await expect(new BailianLlmClient().chatCompletion({
      model: 'qwen-plus-2025-07-28',
      messages: [{ role: 'user', content: 'hello' }],
      timeout_ms: 1,
    })).rejects.toMatchObject({
      type: 'timeout',
      retryable: true,
    });
  });

  it('loads model registry from environment overrides', () => {
    process.env.AGENT_MODEL_MATH = 'qwen-math-turbo-test';

    const registry = getAgentModelRegistry();

    expect(getModelForAgent('supervisor').model).toBe('qwen3.6-plus');
    expect(registry.math_verification).toMatchObject({
      agent_type: 'math_verification',
      model: 'qwen-math-turbo-test',
      provider: 'bailian',
    });
  });
});
