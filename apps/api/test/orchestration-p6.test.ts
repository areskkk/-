import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors/http-error.js';
import { type AgentGraphState } from '../src/modules/agents/agents.types.js';
import {
  createArtifactGraphFromState,
  mergeOwnedArtifactState,
  upsertArtifact,
} from '../src/modules/agents/runtime/artifact-graph.js';
import { selectWorkersForGoal } from '../src/modules/agents/runtime/coordinator-registry.js';
import { executeSubagentFanOut } from '../src/modules/agents/runtime/fanout-executor.js';
import { buildDefaultOrchestrationContract } from '../src/modules/agents/runtime/orchestration-governance.js';
import { aggregateSubagentResults } from '../src/modules/agents/runtime/result-aggregator.js';
import {
  buildDelegationTaskGraph,
  validateTaskGraph,
  type TaskNode,
} from '../src/modules/agents/runtime/task-graph-planner.js';

function baseState(): AgentGraphState {
  return {
    run_id: 'run-p6',
    trace_id: 'trace-p6',
    actor_id: 'actor-p6',
    entrypoint: 'application',
    input: {
      application_id: 'app-1',
      item_id: 'item-1',
      policy_id: 'policy-1',
    },
    errors: [],
  };
}

describe('P6 orchestration abstraction layer', () => {
  it('builds a dependency DAG with topological layers', () => {
    const graph = buildDelegationTaskGraph({
      phase: 'application',
      goal: 'verify application materials',
      subagents: ['document_vision', 'math_verification'],
      fanout_mode: 'parallel',
    });

    expect(graph.version).toBe('task_graph.v1');
    expect(graph.layers[0]).toEqual(['document_vision:1', 'math_verification:2']);
    expect(graph.layers[1]).toEqual(['risk_judge:verifier']);
    expect(
      graph.nodes.find((node) => node.task_id === 'risk_judge:verifier')?.depends_on,
    ).toEqual(['document_vision:1', 'math_verification:2']);
    expect(graph.nodes.map((node) => node.artifact_writes)).toEqual([
      ['document_vision'],
      ['math_verification'],
      ['judge'],
    ]);
  });

  it('rejects invalid task graphs with missing dependencies or cycles', () => {
    const task = (overrides: Partial<TaskNode>): TaskNode => ({
      task_id: 'a',
      phase: 'consultation',
      goal: 'test',
      execution_mode: 'sequential',
      depends_on: [],
      status: 'planned',
      artifact_writes: [],
      ...overrides,
    });

    expect(() => validateTaskGraph({
      version: 'task_graph.v1',
      graph_id: 'missing',
      phase: 'consultation',
      goal: 'test',
      nodes: [task({ depends_on: ['missing-task'] })],
    })).toThrow(ApiError);

    expect(() => validateTaskGraph({
      version: 'task_graph.v1',
      graph_id: 'cycle',
      phase: 'consultation',
      goal: 'test',
      nodes: [
        task({ task_id: 'a', depends_on: ['b'] }),
        task({ task_id: 'b', depends_on: ['a'] }),
      ],
    })).toThrow(ApiError);
  });

  it('selects workers through the coordinator registry and phase policy', () => {
    const selection = selectWorkersForGoal({
      phase: 'consultation',
      goal: 'ground a policy answer',
      requested_workers: ['retrieval_planner', 'policy_analysis', 'document_vision'],
      fanout_mode: 'sequential',
    });

    expect(selection.coordinator).toMatchObject({
      coordinator_id: 'consultation:coordinator',
      planner: 'task_graph_planner.v1',
      worker_selection: 'capability_phase_policy.v1',
    });
    expect(selection.selected_workers).toEqual(['retrieval_planner', 'policy_analysis']);
    expect(selection.task_graph.layers).toEqual([
      ['retrieval_planner:1'],
      ['policy_analysis:2'],
      ['risk_judge:verifier'],
    ]);
  });

  it('records artifact provenance and detects owner conflicts', () => {
    const graph = createArtifactGraphFromState({
      state: {
        ...baseState(),
        judge: {
          approved: true,
          should_fallback: false,
          reasons: [],
          confidence: 0.9,
        },
      },
      agent_type: 'risk_judge',
      source: 'verifier',
    });

    expect(graph.nodes[0]).toMatchObject({
      key: 'judge',
      owner: 'risk_judge',
      provenance: {
        agent_type: 'risk_judge',
        source: 'verifier',
      },
    });

    const conflicted = upsertArtifact(graph, {
      key: 'judge',
      owner: 'runtime',
      provenance: {
        run_id: 'run-p6',
        agent_type: 'runtime',
        source: 'runtime',
      },
    });
    expect(conflicted.conflicts).toEqual([{
      key: 'judge',
      owner: 'risk_judge',
      writer: 'runtime',
      reason: 'artifact_owner_conflict',
    }]);
  });

  it('derives fan-out execution order from the task graph layers', async () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'consultation',
      fanout_mode: 'parallel',
    });
    const taskGraph = buildDelegationTaskGraph({
      phase: 'consultation',
      goal: 'ordered consultation',
      subagents: ['retrieval_planner', 'policy_analysis'],
      fanout_mode: 'sequential',
    });
    const executionOrder: string[] = [];

    await executeSubagentFanOut({
      phase: 'consultation',
      state: {
        ...baseState(),
        entrypoint: 'consultation',
        input: {
          question: 'Can I apply?',
          policy_id: 'policy-1',
        },
      },
      subagents: ['policy_analysis', 'retrieval_planner'],
      task_graph: taskGraph,
      task_input: { objective: 'ordered consultation' },
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
      },
      contract,
      run_subagent: async ({ agent_type: agentType, state }) => {
        executionOrder.push(agentType);
        if (agentType === 'risk_judge') {
          return {
            state: {
              ...state,
              judge: {
                approved: true,
                should_fallback: false,
                reasons: [],
                confidence: 0.9,
              },
            },
            output: {
              approved: true,
              should_fallback: false,
              reasons: [],
              confidence: 0.9,
            },
          };
        }
        if (agentType === 'retrieval_planner') {
          return {
            state: {
              ...state,
              retrieval: {
                query: 'Can I apply?',
                citations: [],
                confidence: 0,
                backend_mode: 'planner_only',
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
              explanation: 'done',
              confidence: 0.8,
            },
          },
          output: {
            result: 'eligible_if_conditions_met',
            matched_conditions: [],
            missing_fields: [],
            explanation: 'done',
            confidence: 0.8,
          },
        };
      },
    });

    expect(executionOrder).toEqual(['retrieval_planner', 'policy_analysis', 'risk_judge']);
  });

  it('builds artifact graph from changed write ledger only', async () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'application',
      fanout_mode: 'parallel',
    });
    const taskGraph = buildDelegationTaskGraph({
      phase: 'application',
      goal: 'verify materials',
      subagents: ['document_vision', 'math_verification'],
      fanout_mode: 'parallel',
    });
    const result = await executeSubagentFanOut({
      phase: 'application',
      state: baseState(),
      subagents: ['document_vision', 'math_verification'],
      task_graph: taskGraph,
      task_input: { objective: 'verify materials' },
      permission_scope: {
        entrypoint: 'application',
        item_id: 'item-1',
        application_id: 'app-1',
        policy_id: 'policy-1',
      },
      contract,
      run_subagent: async ({ agent_type: agentType, state }) => {
        if (agentType === 'risk_judge') {
          return {
            state: {
              ...state,
              judge: {
                approved: true,
                should_fallback: false,
                reasons: [],
                confidence: 0.9,
              },
            },
            output: {
              approved: true,
              should_fallback: false,
              reasons: [],
              confidence: 0.9,
            },
          };
        }
        if (agentType === 'document_vision') {
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
        }
        return {
          state: {
            ...state,
            math_verification: {
              verdict: 'pass',
              explanation: 'numeric conditions pass',
              checked_conditions: [],
              confidence: 0.86,
            },
          },
          output: {
            verdict: 'pass',
            explanation: 'numeric conditions pass',
            checked_conditions: [],
            confidence: 0.86,
          },
        };
      },
    });

    expect(result.state.artifact_graph).toBeUndefined();
    expect(result.artifact_writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'document_vision',
        changed: true,
        task_id: 'document_vision:1',
      }),
      expect.objectContaining({
        key: 'math_verification',
        changed: true,
        task_id: 'math_verification:2',
      }),
      expect.objectContaining({
        key: 'judge',
        changed: true,
        task_id: 'risk_judge:verifier',
      }),
    ]));

    const aggregated = aggregateSubagentResults({
      state: {
        ...result.state,
        judge: {
          approved: true,
          should_fallback: false,
          reasons: [],
          confidence: 0.9,
        },
      },
      phase: 'application',
      subagents: ['document_vision', 'math_verification'],
      permission_scope: {
        entrypoint: 'application',
        item_id: 'item-1',
        application_id: 'app-1',
        policy_id: 'policy-1',
      },
      subagent_results: result.results,
      artifact_writes: result.artifact_writes,
      verifier_output: {
        approved: true,
        should_fallback: false,
        reasons: [],
        confidence: 0.9,
      },
      task_graph: taskGraph,
      fanout_mode: result.mode,
    });

    expect(aggregated.artifact_graph).toMatchObject({
      version: 'artifact_graph.v1',
      nodes: expect.arrayContaining([
        expect.objectContaining({
          key: 'document_vision',
          owner: 'document_vision',
          provenance: expect.objectContaining({
            task_id: 'document_vision:1',
          }),
        }),
        expect.objectContaining({
          key: 'math_verification',
          owner: 'math_verification',
          provenance: expect.objectContaining({
            task_id: 'math_verification:2',
          }),
        }),
        expect.objectContaining({
          key: 'judge',
          owner: 'risk_judge',
          provenance: expect.objectContaining({
            task_id: 'risk_judge:verifier',
          }),
        }),
      ]),
    });
    expect(aggregated.runtime?.subagents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_type: 'risk_judge' }),
    ]));
    expect(aggregated.runtime?.verifier).toMatchObject({
      agent_type: 'risk_judge',
      result_kind: 'final_verifier_result',
      final_judge: {
        approved: true,
        should_fallback: false,
      },
    });
  });

  it('does not write ledger entries or artifact versions for unchanged artifacts', async () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'consultation',
      fanout_mode: 'parallel',
    });
    const taskGraph = buildDelegationTaskGraph({
      phase: 'consultation',
      goal: 'idempotent retrieval planning',
      subagents: ['retrieval_planner'],
      fanout_mode: 'parallel',
    });
    const state: AgentGraphState = {
      ...baseState(),
      entrypoint: 'consultation',
      input: {
        question: 'Can I apply?',
        policy_id: 'policy-1',
      },
      retrieval: {
        query: 'Can I apply?',
        citations: [],
        confidence: 0,
        backend_mode: 'planner_only',
      },
    };

    const result = await executeSubagentFanOut({
      phase: 'consultation',
      state,
      subagents: ['retrieval_planner'],
      task_graph: {
        ...taskGraph,
        nodes: taskGraph.nodes.filter((node) => node.agent_type === 'retrieval_planner'),
        layers: [['retrieval_planner:1']],
      },
      task_input: { objective: 'idempotent retrieval planning' },
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
      },
      contract,
      run_subagent: async ({ state: runState }) => ({
        state: runState,
        output: {
          query: 'Can I apply?',
          policy_id: 'policy-1',
          limit: 3,
        },
      }),
    });

    expect(result.artifact_writes).toEqual([]);

    const aggregated = aggregateSubagentResults({
      state: result.state,
      phase: 'consultation',
      subagents: ['retrieval_planner'],
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
      },
      subagent_results: result.results,
      artifact_writes: result.artifact_writes,
      verifier_output: null,
      task_graph: taskGraph,
      fanout_mode: result.mode,
    });
    expect((aggregated.artifact_graph as { nodes: unknown[] }).nodes).toEqual([]);
  });

  it('rejects artifact writes outside the declared owner contract', () => {
    expect(() => mergeOwnedArtifactState({
      base: baseState(),
      writer: 'document_vision',
      run_state: {
        ...baseState(),
        math_verification: {
          verdict: 'pass',
          explanation: 'wrong writer',
          checked_conditions: [],
          confidence: 0.9,
        },
      },
    })).toThrow(ApiError);
  });
});
