import { type AgentType } from '../../llm/model-registry.js';
import { type AgentPhase, getPhasePolicy } from './phase-policy.js';
import { type TaskGraph, buildDelegationTaskGraph } from './task-graph-planner.js';
import {
  getAllowedSubagents,
  getCoordinatorAgent,
  getSubagentDefinition,
} from './subagent-registry.js';

export type CoordinatorDefinition = {
  coordinator_id: string;
  agent_type: AgentType | string;
  phases: AgentPhase[];
  planner: 'task_graph_planner.v1';
  worker_selection: 'capability_phase_policy.v1';
};

export type WorkerSelectionResult = {
  coordinator: CoordinatorDefinition;
  selected_workers: AgentType[];
  task_graph: TaskGraph;
  target_phase: AgentPhase;
};

export function getCoordinatorForPhase(phase: AgentPhase): CoordinatorDefinition {
  return {
    coordinator_id: `${phase}:coordinator`,
    agent_type: getCoordinatorAgent(phase),
    phases: [phase],
    planner: 'task_graph_planner.v1',
    worker_selection: 'capability_phase_policy.v1',
  };
}

export function selectWorkersForGoal(input: {
  phase: AgentPhase;
  target_phase?: AgentPhase;
  goal: string;
  requested_workers?: AgentType[];
  fanout_mode?: 'sequential' | 'parallel';
}): WorkerSelectionResult {
  const targetPhase = input.target_phase ?? input.phase;
  const phasePolicy = getPhasePolicy(targetPhase);
  const allowedWorkers = getAllowedSubagents(targetPhase).filter((agentType) => {
    const definition = getSubagentDefinition(agentType);
    return definition.role === 'worker' && phasePolicy.agents.includes(agentType);
  });
  const selectedWorkers = (input.requested_workers ?? allowedWorkers).filter((agentType) => (
    allowedWorkers.includes(agentType)
  ));
  const coordinator = getCoordinatorForPhase(input.phase);
  return {
    coordinator,
    selected_workers: selectedWorkers,
    target_phase: targetPhase,
    task_graph: buildDelegationTaskGraph({
      phase: input.phase,
      target_phase: targetPhase,
      goal: input.goal,
      subagents: selectedWorkers,
      fanout_mode: input.fanout_mode ?? 'sequential',
      include_verifier: true,
    }),
  };
}
