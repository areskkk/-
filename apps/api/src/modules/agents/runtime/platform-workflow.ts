import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentGraphState } from '../agents.types.js';
import { type TaskGraph, type TaskNode, validateTaskGraph } from './task-graph-planner.js';

export type WorkflowWaitReason =
  | 'approval'
  | 'timer'
  | 'external_event'
  | 'human_resume'
  | 'dependency';

export type WorkflowWaitStatus =
  | 'waiting'
  | 'resumable'
  | 'resumed'
  | 'expired'
  | 'escalated';

export type WorkflowWaitRecord = {
  wait_id: string;
  task_id: string;
  reason: WorkflowWaitReason;
  status: WorkflowWaitStatus;
  resume_token: string;
  created_at: string;
  resume_after?: string;
  expires_at?: string;
  resumed_at?: string;
  payload?: Record<string, unknown>;
};

export type WorkflowInstanceState = {
  workflow_id: string;
  status: 'running' | 'waiting' | 'completed' | 'failed';
  graph: TaskGraph;
  waits: WorkflowWaitRecord[];
  sla?: {
    timeout_minutes: number;
    escalation_policy: 'manual_review' | 'fail_workflow';
  };
};

export function createWorkflowInstance(input: {
  state: AgentGraphState;
  graph: TaskGraph;
  sla?: WorkflowInstanceState['sla'];
}): AgentGraphState {
  return writeWorkflow(input.state, {
    workflow_id: randomUUID(),
    status: 'running',
    graph: validateTaskGraph(input.graph),
    waits: [],
    sla: input.sla,
  });
}

export function registerWorkflowWait(input: {
  state: AgentGraphState;
  task_id: string;
  reason: WorkflowWaitReason;
  resume_after?: string;
  expires_at?: string;
  payload?: Record<string, unknown>;
}): AgentGraphState {
  const workflow = requireWorkflow(input.state);
  const task = workflow.graph.nodes.find((node) => node.task_id === input.task_id);
  if (!task) {
    throw new ApiError('VALIDATION_ERROR', 'workflow wait task_id does not exist');
  }
  const wait: WorkflowWaitRecord = {
    wait_id: randomUUID(),
    task_id: input.task_id,
    reason: input.reason,
    status: 'waiting',
    resume_token: `workflow:${workflow.workflow_id}:${input.task_id}:${randomUUID()}`,
    created_at: new Date().toISOString(),
    resume_after: input.resume_after,
    expires_at: input.expires_at,
    payload: input.payload,
  };
  return writeWorkflow(input.state, {
    ...workflow,
    status: 'waiting',
    waits: [
      ...workflow.waits,
      wait,
    ],
    graph: markTaskStatus(workflow.graph, input.task_id, 'running'),
  });
}

export function markWorkflowWaitResumable(input: {
  state: AgentGraphState;
  resume_token: string;
  payload?: Record<string, unknown>;
}): AgentGraphState {
  const workflow = requireWorkflow(input.state);
  const wait = workflow.waits.find((item) => item.resume_token === input.resume_token);
  if (!wait) {
    throw new ApiError('NOT_FOUND', 'workflow wait not found');
  }
  if (wait.status !== 'waiting') {
    throw new ApiError('CONFLICT', 'workflow wait is not waiting');
  }
  return writeWorkflow(input.state, {
    ...workflow,
    waits: workflow.waits.map((item) => (
      item.wait_id === wait.wait_id
        ? {
            ...item,
            status: 'resumable',
            payload: input.payload ?? item.payload,
          }
        : item
    )),
  });
}

export function resumeWorkflowWait(input: {
  state: AgentGraphState;
  resume_token: string;
}): AgentGraphState {
  const workflow = requireWorkflow(input.state);
  const wait = workflow.waits.find((item) => item.resume_token === input.resume_token);
  if (!wait) {
    throw new ApiError('NOT_FOUND', 'workflow wait not found');
  }
  if (wait.status !== 'resumable') {
    throw new ApiError('CONFLICT', 'workflow wait is not resumable');
  }
  const graph = markTaskStatus(workflow.graph, wait.task_id, 'completed');
  return writeWorkflow(input.state, {
    ...workflow,
    status: hasOpenWaits(workflow.waits, wait.wait_id) ? 'waiting' : 'running',
    graph,
    waits: workflow.waits.map((item) => (
      item.wait_id === wait.wait_id
        ? {
            ...item,
            status: 'resumed',
            resumed_at: new Date().toISOString(),
          }
        : item
    )),
  });
}

export function evaluateWorkflowSla(input: {
  state: AgentGraphState;
  now?: Date;
}): AgentGraphState {
  const workflow = readWorkflow(input.state);
  if (!workflow) {
    return input.state;
  }
  const now = input.now ?? new Date();
  let escalated = false;
  const waits = workflow.waits.map((wait) => {
    if (
      wait.status !== 'waiting' ||
      !wait.expires_at ||
      new Date(wait.expires_at).getTime() > now.getTime()
    ) {
      return wait;
    }
    escalated = true;
    return {
      ...wait,
      status: workflow.sla?.escalation_policy === 'fail_workflow'
        ? 'expired' as const
        : 'escalated' as const,
    };
  });
  if (!escalated) {
    return input.state;
  }
  return writeWorkflow(input.state, {
    ...workflow,
    status: workflow.sla?.escalation_policy === 'fail_workflow'
      ? 'failed'
      : 'waiting',
    waits,
  });
}

export function readWorkflow(state: AgentGraphState): WorkflowInstanceState | undefined {
  const workflow = state.runtime?.workflow;
  return isWorkflowInstanceState(workflow) ? workflow : undefined;
}

function requireWorkflow(state: AgentGraphState): WorkflowInstanceState {
  const workflow = readWorkflow(state);
  if (!workflow) {
    throw new ApiError('CONFLICT', 'workflow instance is not initialized');
  }
  return workflow;
}

function writeWorkflow(
  state: AgentGraphState,
  workflow: WorkflowInstanceState,
): AgentGraphState {
  return {
    ...state,
    runtime: {
      ...(state.runtime ?? {}),
      workflow,
    },
  };
}

function markTaskStatus(
  graph: TaskGraph,
  taskId: string,
  status: TaskNode['status'],
): TaskGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (
      node.task_id === taskId ? { ...node, status } : node
    )),
  };
}

function hasOpenWaits(waits: WorkflowWaitRecord[], currentWaitId: string): boolean {
  return waits.some((wait) => (
    wait.wait_id !== currentWaitId &&
    (wait.status === 'waiting' || wait.status === 'resumable')
  ));
}

function isWorkflowInstanceState(value: unknown): value is WorkflowInstanceState {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as WorkflowInstanceState).workflow_id === 'string' &&
    (value as WorkflowInstanceState).graph?.version === 'task_graph.v1' &&
    Array.isArray((value as WorkflowInstanceState).waits),
  );
}
