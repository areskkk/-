import {
  insertStep,
  insertToolCall,
} from '../agents.repository.js';
import { auditService } from '../../audit/audit.service.js';
import {
  type AgentRunStepRow,
  type AgentStepStatus,
  type AgentToolCallRow,
  type AgentToolCallStatus,
} from '../agents.types.js';
import { getCurrentAgentLease } from './agent-lease-context.js';

export class AgentStepRecorder {
  async recordStep(input: {
    run_id: string;
    node_name: string;
    agent_type?: string;
    model_name?: string;
    prompt_template_id?: string | null;
    status: AgentStepStatus;
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
    tool_calls?: unknown[];
    token_usage?: Record<string, unknown>;
    error_message?: string;
  }): Promise<AgentRunStepRow> {
    const lease = getCurrentAgentLease();
    const step = await insertStep({
      ...input,
      job_id: lease?.job_id,
      worker_id: lease?.worker_id,
      completed: input.status !== 'running',
    });
    if (input.status !== 'running') {
      await auditService.write({
        actor_id: 'system',
        action: input.status === 'failed'
          ? 'agent_step.failed'
          : 'agent_step.completed',
        target_type: 'agent_run_step',
        target_id: step.step_id,
        detail: {
          run_id: input.run_id,
          node_name: input.node_name,
          agent_type: input.agent_type ?? null,
          model: input.model_name ?? null,
          prompt_version: input.prompt_template_id ?? null,
          status: input.status,
          token_usage: input.token_usage ?? {},
          error_type: input.error_message ? 'step_error' : null,
        },
      });
    }
    return step;
  }

  async recordToolCall(input: {
    run_id: string;
    step_id?: string;
    tool_name: string;
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
    status: AgentToolCallStatus;
    error_message?: string;
  }): Promise<AgentToolCallRow> {
    const lease = getCurrentAgentLease();
    const toolCall = await insertToolCall({
      ...input,
      job_id: lease?.job_id,
      worker_id: lease?.worker_id,
      completed: input.status !== 'running',
    });
    if (input.status !== 'running') {
      await auditService.write({
        actor_id: 'system',
        action: input.status === 'failed'
          ? 'agent_tool_call.failed'
          : 'agent_tool_call.completed',
        target_type: 'agent_tool_call',
        target_id: toolCall.tool_call_id,
        detail: {
          run_id: input.run_id,
          step_id: input.step_id ?? null,
          tool_name: input.tool_name,
          status: input.status,
          error_type: input.error_message ? 'tool_error' : null,
        },
      });
    }
    return toolCall;
  }
}

export const agentStepRecorder = new AgentStepRecorder();
