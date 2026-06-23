import { ApiError } from '../../../common/errors/http-error.js';
import { fallbackService } from '../../fallback/fallback.service.js';
import {
  attachFallbackTaskToRun,
  updateRunStateIfLeased,
} from '../agents.repository.js';
import {
  type AgentGraphState,
  type AgentRunEntrypoint,
  type AgentRunRow,
} from '../agents.types.js';
import { saveCheckpoint } from './checkpoint.repository.js';
import { agentStepRecorder } from './step-recorder.js';

export class MockGraphRunner {
  async run(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
  }): Promise<AgentRunRow> {
    if (input.run.entrypoint === 'mock_completed') {
      return this.runCompleted(input.run);
    }

    if (input.run.entrypoint === 'mock_failed') {
      return this.runFailed(input.run);
    }

    if (input.run.entrypoint === 'mock_interrupted') {
      return this.runInterrupted(input);
    }

    throw new ApiError(
      'VALIDATION_ERROR',
      'Batch 17 only supports mock graph entrypoints',
    );
  }

  async resume(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    task_id: string;
    resume_payload: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    if (input.resume_payload.force_retryable_resume_error === true) {
      const error = new Error('mock retryable resume error') as Error & {
        retryable: boolean;
      };
      error.retryable = true;
      throw error;
    }

    const state = {
      ...input.run.state,
      fallback: {
        ...(input.run.state.fallback ?? {}),
        task_id: input.task_id,
        reason: input.run.state.fallback?.reason ?? 'mock_graph_interrupted',
        resume_payload: input.resume_payload,
      },
      final: {
        status: 'completed',
        answer: 'mock graph resumed',
        next_actions: [],
      },
    };

    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: 'mock_resume',
      agent_type: 'mock_runtime',
      status: 'completed',
      input: {
        task_id: input.task_id,
        resume_payload: input.resume_payload,
      },
      output: {
        resumed: true,
      },
    });
    await saveCheckpoint({
      run_id: input.run.run_id,
      state,
      status: 'completed',
    });

    const updated = await updateRunStateIfLeased({
      run_id: input.run.run_id,
      status: 'completed',
      current_node: 'mock_resume',
      state,
    });

    if (!updated) {
      throw new ApiError('NOT_FOUND', 'agent run not found');
    }
    return updated;
  }

  private async runCompleted(run: AgentRunRow): Promise<AgentRunRow> {
    if (
      run.state.input.message === 'throw-on-first-attempt'
      && run.state.runtime?.retry_probe_failed !== true
    ) {
      const retryState: AgentGraphState = {
        ...run.state,
        runtime: {
          ...(run.state.runtime ?? {}),
          retry_probe_failed: true,
        },
      };
      const updated = await updateRunStateIfLeased({
        run_id: run.run_id,
        status: 'running',
        current_node: 'mock_retry_probe',
        state: retryState,
      });
      if (!updated) {
        throw new ApiError('CONFLICT', 'mock retry probe lost run lease');
      }
      throw new Error('mock retryable graph error');
    }

    let state = setCurrentNode(run.state, 'mock_start');
    await agentStepRecorder.recordStep({
      run_id: run.run_id,
      node_name: 'mock_start',
      agent_type: 'mock_runtime',
      status: 'completed',
      input: state.input,
      output: { accepted: true },
    });
    await saveCheckpoint({ run_id: run.run_id, state });

    const toolCall = await agentStepRecorder.recordToolCall({
      run_id: run.run_id,
      tool_name: 'mock.echo',
      input: { text: state.input.message ?? null },
      output: { echoed: state.input.message ?? null },
      status: 'completed',
    });

    state = {
      ...setCurrentNode(state, 'mock_finalize'),
      final: {
        status: 'completed',
        answer: 'mock graph completed',
        next_actions: [],
      },
    };
    await agentStepRecorder.recordStep({
      run_id: run.run_id,
      node_name: 'mock_finalize',
      agent_type: 'mock_runtime',
      status: 'completed',
      input: { checkpoint: 'mock_start' },
      output: state.final,
      tool_calls: [{
        tool_call_id: toolCall.tool_call_id,
        tool_name: toolCall.tool_name,
        status: toolCall.status,
      }],
    });
    await saveCheckpoint({ run_id: run.run_id, state, status: 'completed' });

    const updated = await updateRunStateIfLeased({
      run_id: run.run_id,
      status: 'completed',
      current_node: 'mock_finalize',
      state,
    });
    if (!updated) {
      throw new ApiError('NOT_FOUND', 'agent run not found');
    }
    return updated;
  }

  private async runFailed(run: AgentRunRow): Promise<AgentRunRow> {
    const state = {
      ...setCurrentNode(run.state, 'mock_failed'),
      errors: [
        ...run.state.errors,
        {
          node: 'mock_failed',
          message: 'mock graph failed intentionally',
        },
      ],
    };

    await agentStepRecorder.recordStep({
      run_id: run.run_id,
      node_name: 'mock_failed',
      agent_type: 'mock_runtime',
      status: 'failed',
      input: state.input,
      output: {},
      error_message: 'mock graph failed intentionally',
    });
    await saveCheckpoint({ run_id: run.run_id, state, status: 'failed' });

    const updated = await updateRunStateIfLeased({
      run_id: run.run_id,
      status: 'failed',
      current_node: 'mock_failed',
      state,
      error_message: 'mock graph failed intentionally',
    });
    if (!updated) {
      throw new ApiError('NOT_FOUND', 'agent run not found');
    }
    return updated;
  }

  private async runInterrupted(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
  }): Promise<AgentRunRow> {
    const run = input.run;
    const fallback = await fallbackService.createIfNotExists({
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      source_type: 'agent_run',
      source_id: run.run_id,
      run_id: run.run_id,
      reason: 'mock_graph_interrupted',
      context: {
        run_id: run.run_id,
        entrypoint: run.entrypoint,
      },
    });
    await attachFallbackTaskToRun({
      task_id: fallback.task.task_id,
      run_id: run.run_id,
    });

    const state = {
      ...setCurrentNode(run.state, 'mock_interrupt'),
      fallback: {
        task_id: fallback.task.task_id,
        reason: 'mock_graph_interrupted',
      },
    };

    await agentStepRecorder.recordStep({
      run_id: run.run_id,
      node_name: 'mock_interrupt',
      agent_type: 'mock_runtime',
      status: 'interrupted',
      input: state.input,
      output: {
        fallback_task_id: fallback.task.task_id,
      },
    });
    await saveCheckpoint({ run_id: run.run_id, state, status: 'interrupted' });

    const updated = await updateRunStateIfLeased({
      run_id: run.run_id,
      status: 'interrupted',
      current_node: 'mock_interrupt',
      state,
    });
    if (!updated) {
      throw new ApiError('NOT_FOUND', 'agent run not found');
    }
    return updated;
  }
}

function setCurrentNode(
  state: AgentGraphState,
  nodeName: string,
): AgentGraphState {
  return {
    ...state,
    current_node: nodeName,
  };
}

export function isMockEntrypoint(entrypoint: AgentRunEntrypoint): boolean {
  return entrypoint.startsWith('mock_');
}

export const mockGraphRunner = new MockGraphRunner();
