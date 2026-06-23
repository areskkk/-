import { ApiError } from '../../../common/errors/http-error.js';
import { loadEnv } from '../../../config/env.js';
import { agentStepRecorder } from '../runtime/step-recorder.js';
import {
  AgentToolError,
  type AgentToolContext,
  type AgentToolExecutionResult,
  type AgentToolName,
} from './tool.types.js';
import { getAgentTool } from './tool-registry.js';
import { assertAgentKillSwitchOpen } from '../runtime/agent-ops-control.js';
import {
  assertToolCircuitClosed,
  recordToolCallFailure,
  recordToolCallSuccess,
} from './tool-health.js';

export class AgentToolRunner {
  async execute<TOutput>(
    name: AgentToolName,
    rawInput: unknown,
    context: AgentToolContext,
  ): Promise<AgentToolExecutionResult<TOutput>> {
    const startedAt = Date.now();
    const tool = getAgentTool(name);
    if (!tool) {
      const error = new AgentToolError({
        type: 'tool_not_found',
        message: `agent tool is not registered: ${name}`,
      });
      await recordFailedToolCall(name, rawInput, context, error);
      throw error;
    }

    if (!tool.allowedAgents.includes(context.agent_type)) {
      const error = new AgentToolError({
        type: 'tool_not_allowed',
        message: `agent ${context.agent_type} is not allowed to call ${name}`,
      });
      await recordFailedToolCall(name, rawInput, context, error);
      throw error;
    }

    try {
      await assertAgentKillSwitchOpen({
        scope: 'tool',
        run_id: context.run_id,
        tool_name: name,
      });
      await assertToolCircuitClosed({
        tool_name: name,
        run_id: context.run_id,
        trace_id: context.trace_id,
      });
      await assertToolCallLimit(context.run_id, context.agent_type);
    } catch (error) {
      const toolError = normalizeToolError(error, 'execution_failed');
      await recordFailedToolCall(name, rawInput, context, toolError);
      await bestEffortRecordToolCallFailure({
        tool_name: name,
        latency_ms: Date.now() - startedAt,
        error: toolError,
      });
      throw toolError;
    }

    let input: unknown;
    try {
      input = tool.validateInput(rawInput);
    } catch (error) {
      const toolError = normalizeToolError(error, 'invalid_input');
      const toolCall = await recordFailedToolCall(name, rawInput, context, toolError);
      await bestEffortRecordToolCallFailure({
        tool_name: name,
        latency_ms: Date.now() - startedAt,
        error: toolError,
      });
      return Promise.reject(Object.assign(toolError, { tool_call: toolCall }));
    }

    try {
      const output = await tool.execute(input, context);
      await bestEffortRecordToolCallSuccess({
        tool_name: name,
        latency_ms: Date.now() - startedAt,
      });
      const toolCall = await agentStepRecorder.recordToolCall({
        run_id: context.run_id,
        tool_name: name,
        input: withToolMetadata(input as Record<string, unknown>, context),
        output: tool.summarizeOutput(output),
        status: 'completed',
      });
      return {
        tool_call: toolCall,
        output: output as TOutput,
      };
    } catch (error) {
      const toolError = normalizeToolError(error, 'execution_failed');
      const toolCall = await recordFailedToolCall(
        name,
        input as Record<string, unknown>,
        context,
        toolError,
      );
      await bestEffortRecordToolCallFailure({
        tool_name: name,
        latency_ms: Date.now() - startedAt,
        error: toolError,
      });
      return Promise.reject(Object.assign(toolError, { tool_call: toolCall }));
    }
  }
}

export const agentToolRunner = new AgentToolRunner();

async function bestEffortRecordToolCallSuccess(
  input: Parameters<typeof recordToolCallSuccess>[0],
): Promise<void> {
  try {
    await recordToolCallSuccess(input);
  } catch {
    // Tool result must not depend on health persistence.
  }
}

async function bestEffortRecordToolCallFailure(
  input: Parameters<typeof recordToolCallFailure>[0],
): Promise<void> {
  try {
    await recordToolCallFailure(input);
  } catch {
    // Tool error classification must not depend on health persistence.
  }
}

async function assertToolCallLimit(
  runId: string,
  agentType: string,
): Promise<void> {
  const limit = loadEnv().agentMaxToolCallsPerAgent;
  const { countToolCallsByRunIdAndAgentType } = await import('../agents.repository.js');
  const toolCallCount = await countToolCallsByRunIdAndAgentType({
    run_id: runId,
    agent_type: agentType,
  });
  if (toolCallCount >= limit) {
    throw new AgentToolError({
      type: 'tool_limit_exceeded',
      message: `agent tool call limit exceeded for ${agentType}`,
    });
  }
}

async function recordFailedToolCall(
  name: AgentToolName,
  rawInput: unknown,
  context: AgentToolContext,
  error: AgentToolError,
) {
  return agentStepRecorder.recordToolCall({
    run_id: context.run_id,
    tool_name: name,
    input: withToolMetadata(
      isRecord(rawInput) ? rawInput : { value: rawInput },
      context,
    ),
    output: {
      error_type: error.type,
      retryable: error.retryable,
    },
    status: 'failed',
    error_message: error.message,
  });
}

function withToolMetadata(
  input: Record<string, unknown>,
  context: AgentToolContext,
): Record<string, unknown> {
  return {
    ...input,
    agent_type: context.agent_type,
    actor_id: context.actor_id,
    trace_id: context.trace_id,
    entrypoint: context.entrypoint ?? null,
    item_id: context.item_id ?? null,
    roles: context.roles ?? [],
    user_type: context.user_type ?? null,
  };
}

function normalizeToolError(
  error: unknown,
  fallbackType: 'invalid_input' | 'execution_failed',
): AgentToolError {
  if (error instanceof AgentToolError) {
    return error;
  }
  if (error instanceof ApiError) {
    if (error.code === 'FORBIDDEN') {
      return new AgentToolError({
        type: 'permission_denied',
        message: error.message,
      });
    }
    if (error.code === 'VALIDATION_ERROR') {
      return new AgentToolError({
        type: 'invalid_input',
        message: error.message,
      });
    }
    if (error.code === 'NOT_FOUND') {
      return new AgentToolError({
        type: 'resource_not_found',
        message: error.message,
      });
    }
  }
  return new AgentToolError({
    type: fallbackType,
    message: error instanceof Error ? error.message : 'agent tool execution failed',
    retryable: fallbackType === 'execution_failed' && isRetryableExecutionError(error),
  });
}

function isRetryableExecutionError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return false;
  }
  if (!(error instanceof Error)) {
    return true;
  }
  const message = error.message.toLowerCase();
  return message.includes('timeout') ||
    message.includes('unavailable') ||
    message.includes('network') ||
    message.includes('temporarily');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
