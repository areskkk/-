import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentType } from '../../llm/model-registry.js';
import { type AgentGraphState } from '../agents.types.js';
import {
  createSubagentExecutionEnvelope,
  runSubagentExecutionEnvelope,
  type SubagentExecutionEnvelopeResult,
} from './subagent-execution-envelope.js';
import {
  assertCrossDomainAllowed,
  buildDefaultOrchestrationContract,
  type FanOutMode,
  type OrchestrationContract,
} from './orchestration-governance.js';
import { type AgentPhase } from './phase-policy.js';
import {
  DEFAULT_SUBAGENT_BUDGET,
  buildSubagentPermissionScope,
  type SubagentBudget,
  type SubagentOutput,
  type SubagentPermissionScope,
} from './subagent-registry.js';
import { mergeOwnedArtifactState } from './artifact-graph.js';
import {
  getExecutableTaskLayers,
  type TaskNode,
  type TaskGraph,
} from './task-graph-planner.js';
import { type ArtifactWriteRecord } from './artifact-graph.js';

export type FanOutExecutionResult = {
  state: AgentGraphState;
  mode: FanOutMode;
  results: SubagentExecutionEnvelopeResult[];
  artifact_writes: ArtifactWriteRecord[];
};

export async function executeSubagentFanOut(input: {
  phase: AgentPhase;
  state: AgentGraphState;
  subagents: AgentType[];
  task_graph?: TaskGraph;
  task_input: Record<string, unknown>;
  permission_scope: SubagentPermissionScope;
  budget?: SubagentBudget;
  contract?: OrchestrationContract;
  run_subagent: (input: {
    agent_type: AgentType;
    state: AgentGraphState;
    task_input: Record<string, unknown>;
    task: TaskNode & { agent_type: AgentType };
    phase: AgentPhase;
  }) => Promise<{
    state: AgentGraphState;
    output: SubagentOutput;
  }>;
  save_child_checkpoint?: (input: {
    parent_state: AgentGraphState;
    child_state: AgentGraphState;
    result: SubagentExecutionEnvelopeResult;
    task: TaskNode & { agent_type: AgentType };
    phase: AgentPhase;
  }) => Promise<{ checkpoint_id: string }>;
}): Promise<FanOutExecutionResult> {
  const budget = input.budget ?? DEFAULT_SUBAGENT_BUDGET;
  if (input.subagents.length > budget.max_subagents) {
    throw new ApiError('RATE_LIMITED', 'subagent fan-out limit exceeded', {
      limit_type: 'subagent_fanout',
      max_subagents: budget.max_subagents,
    });
  }
  const contract = input.contract ?? buildDefaultOrchestrationContract({
    phase: input.phase,
  });
  const executionLayers = input.task_graph
    ? getExecutableTaskLayers(input.task_graph)
    : input.subagents.map((agentType, index) => [fallbackTaskNode(input.phase, agentType, index)]);
  return contract.fanout_mode === 'parallel'
    ? executeParallel({ ...input, budget, contract, executionLayers })
    : executeSequential({ ...input, budget, contract, executionLayers });
}

async function executeSequential(input: RequiredFanOutInput): Promise<FanOutExecutionResult> {
  let state = input.state;
  const results: SubagentExecutionEnvelopeResult[] = [];
  const artifactWrites: ArtifactWriteRecord[] = [];
  for (const layer of input.executionLayers) {
    for (const task of layer) {
      const run = await runOneSubagent({
        ...input,
        task,
        agent_type: task.agent_type,
        state,
      });
      const merged = mergeOwnedArtifacts(state, run);
      state = merged.state;
      results.push(run.result);
      artifactWrites.push(...merged.artifact_writes);
    }
  }
  return {
    state,
    mode: 'sequential',
    results,
    artifact_writes: artifactWrites,
  };
}

async function executeParallel(input: RequiredFanOutInput): Promise<FanOutExecutionResult> {
  let state = input.state;
  const results: SubagentExecutionEnvelopeResult[] = [];
  const artifactWrites: ArtifactWriteRecord[] = [];
  for (const layer of input.executionLayers) {
    const runs = await Promise.all(layer.map((task) => runOneSubagent({
      ...input,
      task,
      agent_type: task.agent_type,
      state,
    })));
    const merged = mergeParallelStates(state, runs);
    state = merged.state;
    results.push(...runs.map((run) => run.result));
    artifactWrites.push(...merged.artifact_writes);
  }
  return {
    state,
    mode: 'parallel',
    results,
    artifact_writes: artifactWrites,
  };
}

async function runOneSubagent(input: RequiredFanOutInput & {
  task: TaskNode & { agent_type: AgentType };
  agent_type: AgentType;
  state: AgentGraphState;
}): Promise<{
  state: AgentGraphState;
  result: SubagentExecutionEnvelopeResult;
  task: TaskNode & { agent_type: AgentType };
}> {
  const config = createSubagentExecutionEnvelope({
    agent_type: input.agent_type,
    permission_scope: resolveTaskPermissionScope(input.permission_scope, input.task),
    budget: input.budget,
    parent_run_id: input.state.run_id,
    task_id: input.task.task_id,
  });
  assertCrossDomainAllowed({
    contract: input.contract,
    from_phase: input.phase,
    target_phase: input.task.target_phase ?? input.task.phase,
  });
  const run = await runSubagentExecutionEnvelope({
    config,
    state: input.state,
    task_input: input.task_input,
    handler: ({ state, task_input }) => input.run_subagent({
      agent_type: input.agent_type,
      state,
      task_input,
      task: input.task,
      phase: input.task.target_phase ?? input.task.phase,
    }),
  });
  const checkpoint = input.save_child_checkpoint
    ? await input.save_child_checkpoint({
        parent_state: input.state,
        child_state: run.state,
        result: run.result,
        task: input.task,
        phase: input.task.target_phase ?? input.task.phase,
      })
    : undefined;
  const result: SubagentExecutionEnvelopeResult = checkpoint
    ? {
        ...run.result,
        runtime: {
          ...run.result.runtime,
          checkpoint_id: checkpoint.checkpoint_id,
        },
      }
    : run.result;
  return {
    state: run.state,
    result,
    task: input.task,
  };
}

function resolveTaskPermissionScope(
  baseScope: SubagentPermissionScope,
  task: TaskNode & { agent_type: AgentType },
): SubagentPermissionScope {
  const targetPhase = task.target_phase ?? task.phase;
  if (baseScope.entrypoint === targetPhase) {
    return baseScope;
  }
  return buildSubagentPermissionScope({
    phase: targetPhase,
    policy_id: baseScope.policy_id,
    application: baseScope.application_id && baseScope.item_id && baseScope.policy_id
      ? {
          application_id: baseScope.application_id,
          item_id: baseScope.item_id,
          policy_id: baseScope.policy_id,
        }
      : undefined,
    review: baseScope.application_id && baseScope.item_id && baseScope.policy_id
      ? {
          application_id: baseScope.application_id,
          item_id: baseScope.item_id,
          policy_id: baseScope.policy_id,
        }
      : undefined,
  });
}

function mergeParallelStates(
  base: AgentGraphState,
  runs: Array<{
    state: AgentGraphState;
    result: SubagentExecutionEnvelopeResult;
    task: TaskNode & { agent_type: AgentType };
  }>,
): {
  state: AgentGraphState;
  artifact_writes: ArtifactWriteRecord[];
} {
  return runs.reduce((merged, run) => {
    const next = mergeOwnedArtifacts(merged.state, run, true);
    return {
      state: next.state,
      artifact_writes: [
        ...merged.artifact_writes,
        ...next.artifact_writes,
      ],
    };
  }, {
    state: base,
    artifact_writes: [] as ArtifactWriteRecord[],
  });
}

function mergeOwnedArtifacts(
  base: AgentGraphState,
  run: {
    state: AgentGraphState;
    result: SubagentExecutionEnvelopeResult;
    task: TaskNode & { agent_type: AgentType };
  },
  rejectExistingWrite = false,
): {
  state: AgentGraphState;
  artifact_writes: ArtifactWriteRecord[];
} {
  try {
    const merged = mergeOwnedArtifactState({
      base,
      run_state: run.state,
      writer: run.result.agent_type,
      task_id: run.task.task_id,
      depends_on: run.task.depends_on,
      reject_existing_write: rejectExistingWrite,
    });
    return {
      state: merged.state,
      artifact_writes: merged.writes,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError('CONFLICT', 'parallel artifact merge failed');
  }
}

type RequiredFanOutInput = {
  phase: AgentPhase;
  state: AgentGraphState;
  subagents: AgentType[];
  executionLayers: Array<Array<TaskNode & { agent_type: AgentType }>>;
  task_input: Record<string, unknown>;
  permission_scope: SubagentPermissionScope;
  budget: SubagentBudget;
  contract: OrchestrationContract;
  run_subagent: (input: {
    agent_type: AgentType;
    state: AgentGraphState;
    task_input: Record<string, unknown>;
    task: TaskNode & { agent_type: AgentType };
    phase: AgentPhase;
  }) => Promise<{
    state: AgentGraphState;
    output: SubagentOutput;
  }>;
  save_child_checkpoint?: (input: {
    parent_state: AgentGraphState;
    child_state: AgentGraphState;
    result: SubagentExecutionEnvelopeResult;
    task: TaskNode & { agent_type: AgentType };
    phase: AgentPhase;
  }) => Promise<{ checkpoint_id: string }>;
};

function fallbackTaskNode(
  phase: AgentPhase,
  agentType: AgentType,
  index: number,
): TaskNode & { agent_type: AgentType } {
  return {
    task_id: `${agentType}:${index + 1}`,
    agent_type: agentType,
    phase,
    goal: 'legacy_delegate_subagent',
    execution_mode: 'sequential',
    depends_on: [],
    status: 'planned',
    artifact_writes: [],
  };
}
