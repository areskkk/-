import { LlmError } from './llm.types.js';

export function parseLlmJson<TJson = unknown>(
  content: string,
  context: {
    provider: string;
    model: string;
    trace_id?: string;
  },
): TJson {
  const trimmed = content.trim();
  const candidate = unwrapMarkdownJson(trimmed);

  try {
    return JSON.parse(candidate) as TJson;
  } catch {
    throw new LlmError({
      type: 'invalid_response',
      message: 'llm returned invalid json content',
      retryable: false,
      provider: context.provider,
      model: context.model,
      trace_id: context.trace_id,
    });
  }
}

function unwrapMarkdownJson(content: string): string {
  const fenceMatch = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : content;
}
