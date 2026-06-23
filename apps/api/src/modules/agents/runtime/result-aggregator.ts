import { type AgentType } from '../../llm/model-registry.js';
import { type AgentGraphState } from '../agents.types.js';
import { type FanOutMode } from './orchestration-governance.js';
import { type SubagentExecutionEnvelopeResult } from './subagent-execution-envelope.js';
import { type AgentPhase } from './phase-policy.js';
import {
  type ArtifactWriteRecord,
  normalizeArtifactGraph,
  upsertArtifact,
} from './artifact-graph.js';
import { type TaskGraph } from './task-graph-planner.js';
import {
  DEFAULT_SUBAGENT_BUDGET,
  getAllowedSubagents,
  getCoordinatorAgent,
  type RiskJudgeOutput,
  type SubagentBudget,
  type SubagentOutput,
  type SubagentPermissionScope,
} from './subagent-registry.js';

export type AggregatedSubagentOutput = {
  agent_type: AgentType;
  output: SubagentOutput;
};

export function aggregateSubagentResults(input: {
  state: AgentGraphState;
  phase: AgentPhase;
  subagents: AgentType[];
  permission_scope: SubagentPermissionScope;
  outputs?: AggregatedSubagentOutput[];
  subagent_results?: SubagentExecutionEnvelopeResult[];
  artifact_writes?: ArtifactWriteRecord[];
  verifier_output: RiskJudgeOutput | null;
  budget?: SubagentBudget;
  fanout_mode?: FanOutMode;
  task_graph?: TaskGraph;
  coordinator_registry?: Record<string, unknown>;
}): AgentGraphState {
  const budget = input.budget ?? DEFAULT_SUBAGENT_BUDGET;
  const subagentResults = input.subagent_results ?? input.outputs?.map((item) => ({
    agent_type: item.agent_type,
    status: 'completed' as const,
    runtime: {
      parent_run_id: input.state.run_id,
      task_id: item.agent_type,
      runtime_id: `subagent:${input.state.run_id}:${item.agent_type}`,
      checkpoint_id: `subagent:${input.state.run_id}:${item.agent_type}:checkpoint:latest`,
      resume_token: `subagent:${input.state.run_id}:${item.agent_type}:resume`,
    },
    permission_scope: input.permission_scope,
    budget: {
      max_turns: budget.max_turns_per_subagent,
      max_tool_calls: budget.max_tool_calls_per_subagent,
    },
    capabilities: {
      independent_tool_loop: false,
      can_delegate: false,
      can_request_human: true,
    },
    turn_count: 1,
    tool_call_count: 0,
    output: item.output,
    error_message: undefined,
  })) ?? [];
  const workerResults = subagentResults.filter((result) => result.agent_type !== 'risk_judge');
  return {
    ...input.state,
    current_node: 'runtime_delegate_subagent',
    artifact_graph: buildAggregationArtifactGraph({
      state: input.state,
      artifact_writes: input.artifact_writes ?? [],
    }),
    runtime: {
      ...(input.state.runtime ?? {}),
      coordinator_registry: input.coordinator_registry ?? input.state.runtime?.coordinator_registry,
      task_graph: input.task_graph ?? input.state.runtime?.task_graph,
      coordinator: {
        agent_type: getCoordinatorAgent(input.phase),
        action: 'delegate_subagent',
        delegated_subagents: input.subagents,
        fanout_count: input.subagents.length,
        fanout_mode: input.fanout_mode ?? 'sequential',
        fanin_strategy: 'risk_judge_verifier',
        fanin_completed: true,
        permission_scope: {
          ...input.permission_scope,
          allowed_subagents: getAllowedSubagents(input.phase),
        },
        budget: {
          max_subagents: budget.max_subagents,
          max_turns_per_subagent: budget.max_turns_per_subagent,
          verifier_required: budget.verifier_required,
        },
      },
      subagents: workerResults.map((result) => ({
        agent_type: result.agent_type,
        result_kind: 'raw_task_output',
        status: result.status,
        runtime: result.runtime,
        permission_scope: result.permission_scope,
        budget: result.budget,
        capabilities: result.capabilities,
        turn_count: result.turn_count,
        tool_call_count: result.tool_call_count,
        output: result.output,
        error_message: result.error_message,
      })),
      verifier: {
        agent_type: 'risk_judge',
        result_kind: 'final_verifier_result',
        status: input.verifier_output ? 'completed' : 'skipped',
        permission_scope: input.permission_scope,
        budget: {
          max_turns: budget.max_turns_per_subagent,
          required: budget.verifier_required,
        },
        final_judge: input.verifier_output,
        judge: input.verifier_output,
      },
    },
  };
}

function buildAggregationArtifactGraph(input: {
  state: AgentGraphState;
  artifact_writes: ArtifactWriteRecord[];
}) {
  let graph = normalizeArtifactGraph(input.state.artifact_graph);
  for (const write of input.artifact_writes) {
    graph = upsertArtifact(graph, {
      key: write.key,
      owner: write.owner,
      provenance: {
        run_id: input.state.run_id,
        task_id: write.task_id,
        agent_type: write.owner,
        source: write.source,
        depends_on: write.depends_on,
      },
    });
  }
  return graph;
}
