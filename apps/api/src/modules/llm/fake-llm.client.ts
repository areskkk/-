import { parseLlmJson } from './llm-json.js';
import {
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmClient,
  type LlmToolCall,
} from './llm.types.js';

type FakeLlmReply = {
  content: string;
  tool_calls?: LlmToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export class FakeLlmClient implements LlmClient {
  private readonly replies: FakeLlmReply[];
  private callIndex = 0;
  private readonly requests: LlmChatRequest[] = [];

  constructor(replies: FakeLlmReply[] = []) {
    this.replies = replies.length > 0 ? replies : [{
      content: '{"ok":true}',
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }];
  }

  async chatCompletion<TJson = unknown>(
    request: LlmChatRequest,
  ): Promise<LlmChatResponse<TJson>> {
    this.requests.push(request);
    const reply = this.replies[Math.min(this.callIndex, this.replies.length - 1)];
    this.callIndex += 1;

    return {
      provider: 'fake',
      model: request.model,
      content: reply.content,
      json:
        request.response_format === 'json_object' && reply.content.trim() !== ''
          ? parseLlmJson<TJson>(reply.content, {
            provider: 'fake',
            model: request.model,
            trace_id: request.trace_id,
          })
          : null,
      tool_calls: reply.tool_calls ?? [],
      usage: reply.usage ?? null,
      raw: {
        choices: [{ message: { content: reply.content, tool_calls: reply.tool_calls ?? [] } }],
        usage: reply.usage ?? null,
      },
    };
  }

  getCallCount(): number {
    return this.callIndex;
  }

  getRequests(): LlmChatRequest[] {
    return [...this.requests];
  }
}
