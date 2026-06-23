import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors/http-error.js';
import { type AgentGraphState, type AgentRunRow } from '../src/modules/agents/agents.types.js';
import { buildCrossDomainRoute } from '../src/modules/agents/runtime/cross-domain-routing.js';
import { resumeNestedAgentRuntime } from '../src/modules/agents/runtime/nested-agent-runtime.js';
import { buildDefaultOrchestrationContract } from '../src/modules/agents/runtime/orchestration-governance.js';
import { executeSubagentFanOut } from '../src/modules/agents/runtime/fanout-executor.js';
import { type NestedRuntimeCheckpointLookup } from '../src/modules/agents/runtime/nested-runtime-checkpoint.js';

function baseState(input: Record<string, unknown> = {}): AgentGraphState {
  return {
    run_id: 'run-p7',
    trace_id: 'trace-p7',
    actor_id: 'actor-p7',
    entrypoint: 'consultation',
    input: {
      question: 'Need cross-domain help',
      policy_id: 'policy-1',
      ...input,
    },
    errors: [],
  };
}

function baseRun(state = baseState()): AgentRunRow {
  return {
    run_id: state.run_id,
    actor_id: state.actor_id,
    entrypoint: state.entrypoint,
    status: 'resuming',
    current_node: 'nested_resume_queued',
    state,
    idempotency_key: null,
    trace_id: state.trace_id,
    error_message: null,
    started_at: '2026-06-17T00:00:00.000Z',
    interrupted_at: null,
    completed_at: null,
    updated_at: '2026-06-17T00:00:00.000Z',
    version: 1,
  };
}

function checkpoint(input: {
  runtime_id?: string;
  agent_type?: string;
  target_phase?: string;
} = {}): NestedRuntimeCheckpointLookup {
  const runtimeId = input.runtime_id ?? 'subagent:run-p7:retrieval_planner:1';
  return {
    checkpoint_id: 'checkpoint-p7',
    run_id: 'run-p7',
    status: 'nested_completed',
    created_at: '2026-06-17T00:00:00.000Z',
    state: {
      ...baseState(),
      current_node: 'runtime_child_checkpointed',
      runtime: {
        nested_checkpoint: {
          parent_run_id: 'run-p7',
          runtime_id: runtimeId,
          task_id: 'retrieval_planner:1',
          resume_token: `${runtimeId}:resume`,
          from_phase: 'consultation',
          target_phase: input.target_phase ?? 'consultation',
          agent_type: input.agent_type ?? 'retrieval_planner',
          status: 'completed',
          checkpoint_status: 'nested_completed',
        },
      },
    },
    lineage: {
      parent_run_id: 'run-p7',
      runtime_id: runtimeId,
      task_id: 'retrieval_planner:1',
      resume_token: `${runtimeId}:resume`,
      from_phase: 'consultation',
      target_phase: input.target_phase ?? 'consultation',
      agent_type: input.agent_type ?? 'retrieval_planner',
      status: 'completed',
      checkpoint_status: 'nested_completed',
    },
  };
}

describe('P7 nested runtime and cross-domain routing', () => {
  it('resumes the exact child runtime from checkpoint lineage', async () => {
    const child = checkpoint({
      runtime_id: 'subagent:run-p7:policy_analysis:2',
      agent_type: 'policy_analysis',
    });

    const result = await resumeNestedAgentRuntime({
      run: baseRun(),
      checkpoint: child,
      resume_payload: {
        child_action: 'respond_final',
      },
      execute_child: async ({ state, checkpoint: childCheckpoint }) => ({
        state: {
          ...state,
          policy_analysis: {
            result: 'eligible_if_conditions_met',
            matched_conditions: [],
            missing_fields: [],
            explanation: 'child resumed exactly',
            confidence: 0.82,
          },
        },
        output: {
          result: 'eligible_if_conditions_met',
          matched_conditions: [],
          missing_fields: [],
          explanation: childCheckpoint.lineage.runtime_id,
          confidence: 0.82,
        },
      }),
    });

    expect(result.parent_status).toBe('completed');
    expect(result.current_node).toBe('nested_runtime_completed');
    expect(result.state.runtime?.nested_resume).toMatchObject({
      runtime_id: 'subagent:run-p7:policy_analysis:2',
      status: 'completed',
    });
  });

  it('parks parent run when child runtime requests human input', async () => {
    const result = await resumeNestedAgentRuntime({
      run: baseRun(),
      checkpoint: checkpoint(),
      resume_payload: {
        child_action: 'request_human',
        reason: 'child needs reviewer',
      },
    });

    expect(result.parent_status).toBe('interrupted');
    expect(result.step_status).toBe('interrupted');
    expect(result.state.runtime?.nested_resume).toMatchObject({
      status: 'interrupted',
      output: {
        reason: 'child needs reviewer',
      },
    });
  });

  it('returns failed fan-in state when child runtime fails', async () => {
    const result = await resumeNestedAgentRuntime({
      run: baseRun(),
      checkpoint: checkpoint(),
      resume_payload: {
        child_action: 'fail',
        error_message: 'child verifier failed',
      },
    });

    expect(result.parent_status).toBe('resume_failed');
    expect(result.checkpoint_status).toBe('nested_failed');
    expect(result.state.errors).toEqual([
      {
        node: 'subagent:run-p7:retrieval_planner:1',
        message: 'child verifier failed',
      },
    ]);
  });

  it('rejects cross-domain target when required target context is missing', () => {
    expect(() => buildCrossDomainRoute({
      state: baseState(),
      from_phase: 'consultation',
      target_phase: 'review',
      contract: buildDefaultOrchestrationContract({
        phase: 'consultation',
        mode: 'cross_domain',
      }),
      tool_scope: {
        policy_id: 'policy-1',
      },
    })).toThrow(ApiError);
  });

  it('enforces target-phase permission boundary for cross-domain workers', async () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'consultation',
      mode: 'cross_domain',
    });

    await expect(executeSubagentFanOut({
      phase: 'consultation',
      state: baseState({
        item_id: 'item-1',
        application_id: 'app-1',
      }),
      subagents: ['document_vision'],
      task_input: {},
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
      },
      contract,
      run_subagent: async ({ state }) => ({
        state,
        output: {
          risk_items: [],
          usable_as_hard_evidence: true,
          confidence: 0.8,
        },
      }),
    })).rejects.toThrow(ApiError);
  });
});
