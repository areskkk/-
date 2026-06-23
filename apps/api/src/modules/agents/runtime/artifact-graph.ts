import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentType } from '../../llm/model-registry.js';
import { type AgentGraphState } from '../agents.types.js';

export type ArtifactKey =
  | 'retrieval'
  | 'policy_analysis'
  | 'document_vision'
  | 'math_verification'
  | 'judge'
  | 'review_draft';

export type ArtifactAccessMode = 'read' | 'write';

export type ArtifactProvenance = {
  run_id: string;
  task_id?: string;
  agent_type: AgentType | 'runtime';
  source: 'tool' | 'subagent' | 'verifier' | 'runtime';
  depends_on?: string[];
};

export type ArtifactNode = {
  artifact_id: string;
  key: ArtifactKey;
  version: number;
  owner: AgentType | 'runtime';
  readers: AgentType[];
  writers: AgentType[];
  merge_policy: 'single_writer' | 'append_only' | 'runtime_replace';
  provenance: ArtifactProvenance;
};

export type ArtifactWriteRecord = {
  key: ArtifactKey;
  owner: AgentType | 'runtime';
  task_id?: string;
  depends_on?: string[];
  changed: boolean;
  source: ArtifactProvenance['source'];
};

export type ArtifactGraph = {
  version: 'artifact_graph.v1';
  nodes: ArtifactNode[];
  conflicts: Array<{
    key: ArtifactKey;
    owner: AgentType | 'runtime';
    writer: AgentType | 'runtime';
    reason: string;
  }>;
};

export const ARTIFACT_OWNER_CONTRACT: Record<AgentType, ArtifactKey[]> = {
  supervisor: [],
  application_assist: [],
  review: [],
  retrieval_planner: ['retrieval'],
  policy_analysis: ['policy_analysis'],
  document_vision: ['document_vision'],
  math_verification: ['math_verification'],
  risk_judge: ['judge'],
};

export const ARTIFACT_KEYS: ArtifactKey[] = [
  'retrieval',
  'policy_analysis',
  'document_vision',
  'math_verification',
  'judge',
  'review_draft',
];

export function getArtifactWritesForAgent(agentType: AgentType): ArtifactKey[] {
  return ARTIFACT_OWNER_CONTRACT[agentType];
}

export function createArtifactGraphFromState(input: {
  state: AgentGraphState;
  run_id?: string;
  source?: ArtifactProvenance['source'];
  agent_type?: AgentType | 'runtime';
}): ArtifactGraph {
  const graph = normalizeArtifactGraph(input.state.artifact_graph);
  const owner = input.agent_type ?? 'runtime';
  return ARTIFACT_KEYS.reduce((nextGraph, key) => {
    if (input.state[key] === undefined) {
      return nextGraph;
    }
    return upsertArtifact(nextGraph, {
      key,
      owner,
      provenance: {
        run_id: input.run_id ?? input.state.run_id,
        agent_type: owner,
        source: input.source ?? 'runtime',
      },
    });
  }, graph);
}

export function mergeOwnedArtifactState(input: {
  base: AgentGraphState;
  run_state: AgentGraphState;
  writer: AgentType;
  task_id?: string;
  depends_on?: string[];
  reject_existing_write?: boolean;
}): {
  state: AgentGraphState;
  writes: ArtifactWriteRecord[];
} {
  const allowedKeys = ARTIFACT_OWNER_CONTRACT[input.writer];
  const changedKeys = allowedKeys.filter((key) => input.run_state[key] !== undefined);
  const disallowedKeys = ARTIFACT_KEYS.filter((key) => (
    !allowedKeys.includes(key) &&
    input.run_state[key] !== undefined &&
    !isStructurallyEqual(input.run_state[key], input.base[key])
  ));
  if (disallowedKeys.length > 0) {
    throw new ApiError(
      'CONFLICT',
      `subagent ${input.writer} wrote disallowed artifacts: ${disallowedKeys.join(',')}`,
    );
  }

  const nextState = { ...input.base };
  const writes: ArtifactWriteRecord[] = [];
  for (const key of changedKeys) {
    const changed = !isStructurallyEqual(input.base[key], input.run_state[key]);
    if (input.reject_existing_write === true && input.base[key] !== undefined && changed) {
      throw new ApiError('CONFLICT', `parallel artifact conflict on ${key}`);
    }
    nextState[key] = input.run_state[key] as never;
    if (changed) {
      writes.push({
        key,
        owner: input.writer,
        task_id: input.task_id,
        depends_on: input.depends_on,
        changed,
        source: input.writer === 'risk_judge' ? 'verifier' : 'subagent',
      });
    }
  }

  return {
    state: {
      ...nextState,
      current_node: input.run_state.current_node ?? nextState.current_node,
    },
    writes,
  };
}

export function upsertArtifact(
  graph: ArtifactGraph,
  input: {
    key: ArtifactKey;
    owner: AgentType | 'runtime';
    provenance: ArtifactProvenance;
  },
): ArtifactGraph {
  const existing = graph.nodes.find((node) => node.key === input.key);
  if (existing && existing.owner !== input.owner) {
    return {
      ...graph,
      conflicts: [
        ...graph.conflicts,
        {
          key: input.key,
          owner: existing.owner,
          writer: input.owner,
          reason: 'artifact_owner_conflict',
        },
      ],
    };
  }
  const version = existing ? existing.version + 1 : 1;
  const node: ArtifactNode = {
    artifact_id: `${input.key}:v${version}`,
    key: input.key,
    version,
    owner: input.owner,
    readers: [],
    writers: input.owner === 'runtime' ? [] : [input.owner],
    merge_policy: input.owner === 'runtime' ? 'runtime_replace' : 'single_writer',
    provenance: input.provenance,
  };
  return {
    ...graph,
    nodes: [
      ...graph.nodes.filter((item) => item.key !== input.key),
      node,
    ],
  };
}

export function normalizeArtifactGraph(value: unknown): ArtifactGraph {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      version: 'artifact_graph.v1',
      nodes: [],
      conflicts: [],
    };
  }
  const graph = value as Partial<ArtifactGraph>;
  return {
    version: 'artifact_graph.v1',
    nodes: Array.isArray(graph.nodes) ? graph.nodes.filter(isArtifactNode) : [],
    conflicts: Array.isArray(graph.conflicts) ? graph.conflicts.filter(isArtifactConflict) : [],
  };
}

function isArtifactNode(value: unknown): value is ArtifactNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const node = value as Partial<ArtifactNode>;
  return (
    typeof node.artifact_id === 'string' &&
    typeof node.key === 'string' &&
    typeof node.version === 'number' &&
    typeof node.owner === 'string' &&
    Array.isArray(node.readers) &&
    Array.isArray(node.writers) &&
    typeof node.merge_policy === 'string' &&
    Boolean(node.provenance)
  );
}

function isArtifactConflict(value: unknown): value is ArtifactGraph['conflicts'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const conflict = value as Partial<ArtifactGraph['conflicts'][number]>;
  return (
    typeof conflict.key === 'string' &&
    typeof conflict.owner === 'string' &&
    typeof conflict.writer === 'string' &&
    typeof conflict.reason === 'string'
  );
}

function isStructurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
