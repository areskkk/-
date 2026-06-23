import { LlmError } from '../../llm/llm.types.js';
import {
  type LlmChatResponse,
  type LlmMessage,
  type LlmToolCall,
  type LlmToolDefinition,
} from '../../llm/llm.types.js';
import { type AgentType } from '../../llm/model-registry.js';
import { agentToolRunner } from '../tools/tool-runner.js';
import { getAgentTool } from '../tools/tool-registry.js';
import {
  type AgentToolContext,
  type AgentToolName,
} from '../tools/tool.types.js';

const DEFAULT_MAX_TOOL_ROUNDS = 2;

export type AgentToolLoopResult<TJson> = {
  response: LlmChatResponse<TJson>;
  messages: LlmMessage[];
  tool_calls: Array<{
    tool_call_id: string;
    tool_name: string;
    status: string;
  }>;
  tool_results: Array<{
    tool_name: AgentToolName;
    output: unknown;
  }>;
};

export async function runAgentToolLoop<TJson>(input: {
  chatCompletion: (request: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    tool_choice: 'auto';
  }) => Promise<LlmChatResponse<TJson>>;
  base_messages: LlmMessage[];
  allowed_tools: AgentToolName[];
  context: AgentToolContext;
  prepare_tool_input?: (input: {
    tool_name: AgentToolName;
    tool_input: Record<string, unknown>;
  }) => Record<string, unknown>;
  max_tool_rounds?: number;
}): Promise<AgentToolLoopResult<TJson>> {
  const tools = input.allowed_tools.map(toLlmToolDefinition);
  const messages = [...input.base_messages];
  const toolCallRefs: AgentToolLoopResult<TJson>['tool_calls'] = [];
  const toolResults: AgentToolLoopResult<TJson>['tool_results'] = [];
  const maxRounds = input.max_tool_rounds ?? DEFAULT_MAX_TOOL_ROUNDS;

  for (let round = 0; round <= maxRounds; round += 1) {
    const response = await input.chatCompletion({
      messages,
      tools,
      tool_choice: 'auto',
    });
    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return {
        response,
        messages,
        tool_calls: toolCallRefs,
        tool_results: toolResults,
      };
    }
    if (round >= maxRounds) {
      throw new LlmError({
        type: 'invalid_response',
        message: 'llm exceeded maximum tool call rounds',
        retryable: false,
        provider: response.provider,
        model: response.model,
        trace_id: input.context.trace_id,
      });
    }

    messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: toolCalls,
    });
    for (const toolCall of toolCalls) {
      const toolName = assertAllowedToolCall(toolCall, input.allowed_tools);
      const rawToolInput = parseToolArguments(toolCall);
      const toolInput = input.prepare_tool_input
        ? input.prepare_tool_input({
          tool_name: toolName,
          tool_input: rawToolInput,
        })
        : rawToolInput;
      const toolResult = await agentToolRunner.execute(
        toolName,
        toolInput,
        input.context,
      );
      toolCallRefs.push({
        tool_call_id: toolResult.tool_call.tool_call_id,
        tool_name: toolResult.tool_call.tool_name,
        status: toolResult.tool_call.status,
      });
      toolResults.push({
        tool_name: toolName,
        output: toolResult.output,
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolName,
        content: JSON.stringify(toolResult.output),
      });
    }
  }

  throw new LlmError({
    type: 'invalid_response',
    message: 'llm tool loop did not finish',
    retryable: false,
    provider: 'agent_runtime',
    trace_id: input.context.trace_id,
  });
}

function toLlmToolDefinition(name: AgentToolName): LlmToolDefinition {
  const tool = getAgentTool(name);
  if (!tool) {
    throw new LlmError({
      type: 'invalid_response',
      message: `agent tool is not registered: ${name}`,
      retryable: false,
      provider: 'agent_runtime',
    });
  }
  return {
    type: 'function',
    function: {
      name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function assertAllowedToolCall(
  toolCall: LlmToolCall,
  allowedTools: AgentToolName[],
): AgentToolName {
  const name = toolCall.function.name;
  if (!allowedTools.includes(name as AgentToolName)) {
    throw new LlmError({
      type: 'invalid_response',
      message: `llm requested disallowed tool: ${name}`,
      retryable: false,
      provider: 'agent_runtime',
    });
  }
  return name as AgentToolName;
}

function parseToolArguments(toolCall: LlmToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('tool arguments must be an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new LlmError({
      type: 'invalid_response',
      message: error instanceof Error ? error.message : 'invalid tool arguments',
      retryable: false,
      provider: 'agent_runtime',
    });
  }
}
