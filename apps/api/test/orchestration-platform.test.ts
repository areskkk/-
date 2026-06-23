import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors/http-error.js';
import { type AgentGraphState } from '../src/modules/agents/agents.types.js';
import { requireApprovalForSideEffect, resumeAfterApproval } from '../src/modules/agents/runtime/approval-gate.js';
import {
  createSubagentExecutionEnvelope,
  runSubagentExecutionEnvelope,
} from '../src/modules/agents/runtime/subagent-execution-envelope.js';
import { executeSubagentFanOut } from '../src/modules/agents/runtime/fanout-executor.js';
import {
  arbitrateAgentConflicts,
  assertCrossDomainAllowed,
  buildDefaultOrchestrationContract,
  resolveCrossDomainArtifactPolicy,
} from '../src/modules/agents/runtime/orchestration-governance.js';
import { buildDelegationTaskGraph } from '../src/modules/agents/runtime/task-graph-planner.js';
import {
  buildNestedRuntimeResumeState,
  type NestedRuntimeCheckpointLookup,
} from '../src/modules/agents/runtime/nested-runtime-checkpoint.js';

function baseState(): AgentGraphState {
  return {
    run_id: 'run-1',
    trace_id: 'trace-1',
    actor_id: 'actor-1',
    entrypoint: 'consultation',
    input: {
      question: 'Can I apply?',
      policy_id: 'policy-1',
    },
    errors: [],
  };
}

describe('orchestration platform capabilities', () => {
  it('executes generic parallel fan-out and records subagent envelope metadata', async () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'consultation',
      fanout_mode: 'parallel',
    });
    const result = await executeSubagentFanOut({
      phase: 'consultation',
      state: baseState(),
      subagents: ['retrieval_planner', 'policy_analysis'],
      task_input: { objective: 'parallel fanout' },
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
      },
      contract,
      run_subagent: async ({ agent_type: agentType, state }) => {
        if (agentType === 'retrieval_planner') {
          return {
            state: {
              ...state,
              retrieval: {
                query: 'Can I apply?',
                citations: [],
                confidence: 0.8,
                backend_mode: 'local_fallback',
              },
            },
            output: {
              query: 'Can I apply?',
              policy_id: 'policy-1',
              limit: 3,
            },
          };
        }
        return {
          state: {
            ...state,
            policy_analysis: {
              result: 'eligible_if_conditions_met',
              matched_conditions: [],
              missing_fields: [],
              explanation: 'Parallel worker finished.',
              confidence: 0.82,
            },
          },
          output: {
            result: 'eligible_if_conditions_met',
            matched_conditions: [],
            missing_fields: [],
            explanation: 'Parallel worker finished.',
            confidence: 0.82,
          },
        };
      },
    });

    expect(result.mode).toBe('parallel');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      agent_type: 'retrieval_planner',
      budget: {
        max_turns: 1,
        max_tool_calls: 0,
      },
      capabilities: {
        can_delegate: false,
        can_request_human: true,
      },
      turn_count: 1,
      tool_call_count: 0,
    });
    expect(result.state.retrieval).toBeDefined();
    expect(result.state.policy_analysis).toBeDefined();
  });

  it('enforces subagent envelope turn and tool budgets', async () => {
    const config = createSubagentExecutionEnvelope({
      agent_type: 'retrieval_planner',
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
      },
    });

    await expect(runSubagentExecutionEnvelope({
      config,
      state: baseState(),
      task_input: {},
      handler: async ({ state }) => ({
        state,
        output: {
          query: 'Can I apply?',
          policy_id: 'policy-1',
          limit: 3,
        },
        tool_call_count: 1,
      }),
    })).rejects.toThrow(ApiError);
  });

  it('creates explicit approval requests and resumes from decisions', () => {
    const state = requireApprovalForSideEffect({
      state: baseState(),
      side_effect_class: 'approval_required',
      reason: 'review_decision_requires_human',
      context: {
        item_id: 'item-1',
      },
    });

    const approvals = (state.control as { approval_requests: Array<{ approval_id: string }> })
      .approval_requests;
    expect(approvals).toHaveLength(1);

    const resumed = resumeAfterApproval({
      state,
      decision: {
        approval_id: approvals[0].approval_id,
        status: 'approved',
        decided_by: 'reviewer-1',
        decided_at: '2026-06-16T00:00:00.000Z',
      },
    });
    expect((resumed.control as Record<string, unknown>).manual_resume).toBe(true);
  });

  it('formalizes governance defaults for replay, side effects, and conflict arbitration', () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'review',
    });
    expect(contract.replay_granularity).toEqual([
      'run',
      'step',
      'tool_call',
      'llm_call',
    ]);
    expect(contract.side_effect_policy.external_mutation).toMatchObject({
      allowed: false,
      approval_required: true,
    });

    const arbitration = arbitrateAgentConflicts({
      contract,
      signals: [
        {
          agent_type: 'document_vision',
          confidence: 0.92,
          approved: true,
        },
        {
          agent_type: 'risk_judge',
          confidence: 0.66,
          approved: false,
          should_fallback: true,
          reasons: ['manual review required'],
        },
      ],
    });
    expect(arbitration).toMatchObject({
      decision: 'request_human',
      reasons: expect.arrayContaining([
        'manual review required',
        'agent_requested_fallback',
        'agent_approval_conflict',
        'low_confidence:risk_judge',
      ]),
    });
  });

  it('keeps cross-domain collaboration gated unless explicitly enabled', () => {
    const guarded = buildDefaultOrchestrationContract({
      phase: 'consultation',
    });
    expect(() => assertCrossDomainAllowed({
      contract: guarded,
      from_phase: 'consultation',
      target_phase: 'review',
    })).toThrow(ApiError);

    const open = buildDefaultOrchestrationContract({
      phase: 'consultation',
      mode: 'cross_domain',
    });
    expect(() => assertCrossDomainAllowed({
      contract: open,
      from_phase: 'consultation',
      target_phase: 'review',
    })).not.toThrow();
    expect(open.cross_domain).toMatchObject({
      artifact_scope: 'target_phase_owner',
      read_boundary: 'source_context_readonly',
      draft_boundary: 'target_phase_draft_only',
      write_boundary: 'approval_required',
      resume_contract: 'parent_runtime_controls_child_resume',
      audit_lineage_required: true,
    });
    expect(resolveCrossDomainArtifactPolicy({
      contract: open,
      from_phase: 'consultation',
      target_phase: 'review',
      artifact_key: 'document_vision',
    })).toEqual({
      key: 'document_vision',
      owner_phase: 'review',
      read_boundary: 'source_context_readonly',
      draft_boundary: 'target_phase_draft_only',
      write_boundary: 'approval_required',
      approval_required: true,
    });
  });

  it('drives cross-domain worker execution from target_phase task graph', async () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'consultation',
      mode: 'cross_domain',
    });
    const taskGraph = buildDelegationTaskGraph({
      phase: 'consultation',
      target_phase: 'review',
      goal: 'review submitted evidence from consultation',
      subagents: ['document_vision'],
      fanout_mode: 'sequential',
      include_verifier: false,
    });
    const phases: string[] = [];

    const result = await executeSubagentFanOut({
      phase: 'consultation',
      state: baseState(),
      subagents: ['document_vision'],
      task_graph: taskGraph,
      task_input: {
        objective: 'cross-domain document review',
      },
      permission_scope: {
        entrypoint: 'review',
        item_id: 'item-1',
        application_id: 'app-1',
        policy_id: 'policy-1',
      },
      contract,
      run_subagent: async ({ phase, state }) => {
        phases.push(phase);
        return {
          state: {
            ...state,
            document_vision: {
              risk_items: [],
              usable_as_hard_evidence: true,
              confidence: 0.88,
            },
          },
          output: {
            risk_items: [],
            usable_as_hard_evidence: true,
            confidence: 0.88,
          },
        };
      },
    });

    expect(phases).toEqual(['review']);
    expect(taskGraph.nodes[0]).toMatchObject({
      phase: 'review',
      target_phase: 'review',
    });
    expect(result.results[0]).toMatchObject({
      agent_type: 'document_vision',
      runtime: {
        parent_run_id: 'run-1',
        task_id: 'document_vision:1',
        runtime_id: 'subagent:run-1:document_vision:1',
        checkpoint_id: 'subagent:run-1:document_vision:1:checkpoint:latest',
        resume_token: 'subagent:run-1:document_vision:1:resume',
      },
      capabilities: {
        independent_tool_loop: false,
        can_request_human: true,
      },
    });
  });

  it('blocks target_phase task execution without cross_domain mode', async () => {
    const taskGraph = buildDelegationTaskGraph({
      phase: 'consultation',
      target_phase: 'review',
      goal: 'guarded cross-domain review',
      subagents: ['document_vision'],
      fanout_mode: 'sequential',
      include_verifier: false,
    });

    await expect(executeSubagentFanOut({
      phase: 'consultation',
      state: baseState(),
      subagents: ['document_vision'],
      task_graph: taskGraph,
      task_input: {},
      permission_scope: {
        entrypoint: 'review',
        item_id: 'item-1',
        application_id: 'app-1',
        policy_id: 'policy-1',
      },
      contract: buildDefaultOrchestrationContract({
        phase: 'consultation',
      }),
      run_subagent: async ({ state }) => ({
        state,
        output: {
          risk_items: [],
          usable_as_hard_evidence: true,
          confidence: 0.88,
        },
      }),
    })).rejects.toThrow(ApiError);
  });

  it('persists nested runtime checkpoint lineage through the fan-out hook', async () => {
    const checkpoints: Array<{
      runtime_id: string;
      parent_run_id?: string;
      target_phase: string;
    }> = [];
    const taskGraph = buildDelegationTaskGraph({
      phase: 'consultation',
      goal: 'checkpoint child runtime',
      subagents: ['retrieval_planner'],
      fanout_mode: 'sequential',
      include_verifier: false,
    });

    const result = await executeSubagentFanOut({
      phase: 'consultation',
      state: baseState(),
      subagents: ['retrieval_planner'],
      task_graph: taskGraph,
      task_input: {},
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
      },
      contract: buildDefaultOrchestrationContract({
        phase: 'consultation',
      }),
      run_subagent: async ({ state }) => ({
        state: {
          ...state,
          retrieval: {
            query: 'Can I apply?',
            citations: [],
            confidence: 0.8,
            backend_mode: 'local_fallback',
          },
        },
        output: {
          query: 'Can I apply?',
          policy_id: 'policy-1',
          limit: 3,
        },
      }),
      save_child_checkpoint: async ({ result: childResult, phase }) => {
        checkpoints.push({
          runtime_id: childResult.runtime.runtime_id,
          parent_run_id: childResult.runtime.parent_run_id,
          target_phase: phase,
        });
        return {
          checkpoint_id: 'checkpoint-db-row-1',
        };
      },
    });

    expect(checkpoints).toEqual([{
      runtime_id: 'subagent:run-1:retrieval_planner:1',
      parent_run_id: 'run-1',
      target_phase: 'consultation',
    }]);
    expect(result.results[0].runtime).toMatchObject({
      checkpoint_id: 'checkpoint-db-row-1',
      resume_token: 'subagent:run-1:retrieval_planner:1:resume',
    });
  });

  it('builds a resumable nested runtime state from checkpoint lineage', () => {
    const checkpoint: NestedRuntimeCheckpointLookup = {
      checkpoint_id: 'checkpoint-db-row-1',
      run_id: 'run-1',
      status: 'nested_completed',
      created_at: '2026-06-16T00:00:00.000Z',
      state: {
        ...baseState(),
        current_node: 'runtime_retrieval_planner',
        runtime: {
          nested_checkpoint: {
            parent_run_id: 'run-1',
            runtime_id: 'subagent:run-1:retrieval_planner:1',
            task_id: 'retrieval_planner:1',
            resume_token: 'subagent:run-1:retrieval_planner:1:resume',
            from_phase: 'consultation',
            target_phase: 'consultation',
            agent_type: 'retrieval_planner',
            status: 'completed',
          },
        },
      },
      lineage: {
        parent_run_id: 'run-1',
        runtime_id: 'subagent:run-1:retrieval_planner:1',
        task_id: 'retrieval_planner:1',
        resume_token: 'subagent:run-1:retrieval_planner:1:resume',
        from_phase: 'consultation',
        target_phase: 'consultation',
        agent_type: 'retrieval_planner',
        status: 'completed',
      },
    };

    const state = buildNestedRuntimeResumeState({
      checkpoint,
      resume_payload: {
        manual_decision: 'retry_child',
      },
    });

    expect(state.current_node).toBe('nested_resume_queued');
    expect(state.runtime?.nested_resume).toMatchObject({
      parent_run_id: 'run-1',
      runtime_id: 'subagent:run-1:retrieval_planner:1',
      task_id: 'retrieval_planner:1',
      resume_token: 'subagent:run-1:retrieval_planner:1:resume',
      resumed_from_checkpoint_id: 'checkpoint-db-row-1',
      target_phase: 'consultation',
      payload: {
        manual_decision: 'retry_child',
      },
    });
  });

  it('rejects parallel artifact writes outside the subagent ownership contract', async () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'consultation',
      fanout_mode: 'parallel',
    });

    await expect(executeSubagentFanOut({
      phase: 'consultation',
      state: baseState(),
      subagents: ['retrieval_planner'],
      task_input: {},
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
      },
      contract,
      run_subagent: async ({ state }) => ({
        state: {
          ...state,
          policy_analysis: {
            result: 'bad_write',
            matched_conditions: [],
            missing_fields: [],
            explanation: 'retrieval planner cannot write policy_analysis',
            confidence: 0.8,
          },
        },
        output: {
          query: 'Can I apply?',
          policy_id: 'policy-1',
          limit: 3,
        },
      }),
    })).rejects.toThrow(ApiError);
  });
});
