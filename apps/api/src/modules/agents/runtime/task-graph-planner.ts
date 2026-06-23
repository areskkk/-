import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentType } from '../../llm/model-registry.js';
import { type AgentPhase } from './phase-policy.js';
import { getArtifactWritesForAgent, type ArtifactKey } from './artifact-graph.js';

export type TaskExecutionMode = 'sequential' | 'parallel' | 'conditional' | 'wait';
export type TaskNodeStatus = 'planned' | 'running' | 'completed' | 'failed' | 'skipped';

export type TaskNode = {
  task_id: string;
  agent_type?: AgentType;
  phase: AgentPhase;
  target_phase?: AgentPhase;
  goal: string;
  execution_mode: TaskExecutionMode;
  depends_on: string[];
  status: TaskNodeStatus;
  artifact_writes: ArtifactKey[];
};

export type TaskGraph = {
  version: 'task_graph.v1';
  graph_id: string;
  phase: AgentPhase;
  goal: string;
  nodes: TaskNode[];
  layers: string[][];
};

export function buildDelegationTaskGraph(input: {
  phase: AgentPhase;
  target_phase?: AgentPhase;
  goal: string;
  subagents: AgentType[];
  fanout_mode: 'sequential' | 'parallel';
  include_verifier?: boolean;
}): TaskGraph {
  const targetPhase = input.target_phase ?? input.phase;
  const workerNodes = input.subagents.map((agentType, index) => {
    return {
      task_id: `${agentType}:${index + 1}`,
      agent_type: agentType,
      phase: targetPhase,
      target_phase: targetPhase,
      goal: `write:${getArtifactWritesForAgent(agentType).join(',')}`,
      execution_mode: input.fanout_mode,
      depends_on: input.fanout_mode === 'sequential' && index > 0
        ? [`${input.subagents[index - 1]}:${index}`]
        : [],
      status: 'planned' as const,
      artifact_writes: getArtifactWritesForAgent(agentType),
    };
  });
  const verifierNode: TaskNode[] = input.include_verifier === false
    ? []
    : [{
        task_id: 'risk_judge:verifier',
        agent_type: 'risk_judge',
        phase: targetPhase,
        target_phase: targetPhase,
        goal: 'write:judge',
        execution_mode: 'wait',
        depends_on: workerNodes.map((node) => node.task_id),
        status: 'planned',
        artifact_writes: ['judge'],
      }];
  return validateTaskGraph({
    version: 'task_graph.v1',
    graph_id: `${input.phase}:${Date.now()}`,
    phase: input.phase,
    goal: input.goal,
    nodes: [
      ...workerNodes,
      ...verifierNode,
    ],
    layers: [],
  });
}

export function getExecutableWorkerLayers(graph: TaskGraph): AgentType[][] {
  return getExecutableTaskLayers(graph)
    .map((layer) => layer
      .filter((node) => node.execution_mode !== 'wait' && node.execution_mode !== 'conditional')
      .map((node) => node.agent_type))
    .filter((layer) => layer.length > 0);
}

export function getExecutableTaskLayers(
  graph: TaskGraph,
): Array<Array<TaskNode & { agent_type: AgentType }>> {
  const nodesById = new Map(graph.nodes.map((node) => [node.task_id, node]));
  return graph.layers
    .map((layer) => layer
      .map((taskId) => nodesById.get(taskId))
      .filter(isExecutableTask))
    .filter((layer) => layer.length > 0);
}

export function getVerifierTasks(graph: TaskGraph): Array<TaskNode & { agent_type: AgentType }> {
  return graph.nodes.filter((node): node is TaskNode & { agent_type: AgentType } => (
    Boolean(node.agent_type) &&
    node.execution_mode === 'wait'
  ));
}

function isExecutableTask(
  node: TaskNode | undefined,
): node is TaskNode & { agent_type: AgentType } {
  return Boolean(node?.agent_type);
}

export function validateTaskGraph(graph: Omit<TaskGraph, 'layers'> & {
  layers?: string[][];
}): TaskGraph {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.task_id)) {
      throw new ApiError('VALIDATION_ERROR', `duplicate task id ${node.task_id}`);
    }
    ids.add(node.task_id);
  }
  for (const node of graph.nodes) {
    for (const dependency of node.depends_on) {
      if (!ids.has(dependency)) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `task ${node.task_id} depends on missing task ${dependency}`,
        );
      }
    }
  }
  return {
    ...graph,
    layers: buildTopologicalLayers(graph.nodes),
  };
}

export function buildTopologicalLayers(nodes: TaskNode[]): string[][] {
  const pending = new Map(nodes.map((node) => [node.task_id, new Set(node.depends_on)]));
  const layers: string[][] = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([taskId]) => taskId);
    if (ready.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'task graph contains a cycle');
    }
    layers.push(ready);
    for (const taskId of ready) {
      pending.delete(taskId);
    }
    for (const dependencies of pending.values()) {
      for (const taskId of ready) {
        dependencies.delete(taskId);
      }
    }
  }
  return layers;
}
