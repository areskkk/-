import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentType } from '../../llm/model-registry.js';
import { type AgentPhase } from './phase-policy.js';
import { type ArtifactKey } from './artifact-graph.js';
import { runArbitrationStrategy, type ArbitrationStrategy } from './arbitration-strategies.js';

export type OrchestrationMode = 'phase_guarded' | 'cross_domain';
export type FanOutMode = 'sequential' | 'parallel';
export type ReplayGranularity = 'run' | 'step' | 'tool_call' | 'llm_call';
export type SideEffectClass = 'none' | 'read_only' | 'draft_only' | 'approval_required' | 'external_mutation';

export type OrchestrationContract = {
  version: 'orchestration.v1';
  mode: OrchestrationMode;
  phase: AgentPhase;
  fanout_mode: FanOutMode;
  cross_domain: {
    artifact_scope: 'target_phase_owner';
    read_boundary: 'source_context_readonly';
    draft_boundary: 'target_phase_draft_only';
    write_boundary: 'approval_required';
    resume_contract: 'parent_runtime_controls_child_resume';
    audit_lineage_required: boolean;
  };
  replay_granularity: ReplayGranularity[];
  side_effect_policy: Record<SideEffectClass, {
    allowed: boolean;
    approval_required: boolean;
  }>;
  conflict_policy: {
    low_confidence_threshold: number;
    require_human_on_conflict: boolean;
    arbitration_strategy: ArbitrationStrategy;
  };
};

export type AgentConflictSignal = {
  agent_type: AgentType;
  approved?: boolean;
  should_fallback?: boolean;
  confidence: number;
  reasons?: string[];
};

export type ConflictArbitrationResult = {
  decision: 'accept' | 'request_human' | 'reject';
  reasons: string[];
  confidence: number;
};

export type CrossDomainArtifactPolicy = {
  key: ArtifactKey;
  owner_phase: AgentPhase;
  read_boundary: OrchestrationContract['cross_domain']['read_boundary'];
  draft_boundary: OrchestrationContract['cross_domain']['draft_boundary'];
  write_boundary: OrchestrationContract['cross_domain']['write_boundary'];
  approval_required: boolean;
};

export function buildDefaultOrchestrationContract(input: {
  phase: AgentPhase;
  mode?: OrchestrationMode;
  fanout_mode?: FanOutMode;
}): OrchestrationContract {
  return {
    version: 'orchestration.v1',
    mode: input.mode ?? 'phase_guarded',
    phase: input.phase,
    fanout_mode: input.fanout_mode ?? 'sequential',
    cross_domain: {
      artifact_scope: 'target_phase_owner',
      read_boundary: 'source_context_readonly',
      draft_boundary: 'target_phase_draft_only',
      write_boundary: 'approval_required',
      resume_contract: 'parent_runtime_controls_child_resume',
      audit_lineage_required: true,
    },
    replay_granularity: ['run', 'step', 'tool_call', 'llm_call'],
    side_effect_policy: {
      none: { allowed: true, approval_required: false },
      read_only: { allowed: true, approval_required: false },
      draft_only: { allowed: true, approval_required: false },
      approval_required: { allowed: true, approval_required: true },
      external_mutation: { allowed: false, approval_required: true },
    },
    conflict_policy: {
      low_confidence_threshold: 0.7,
      require_human_on_conflict: true,
      arbitration_strategy: 'rule_based',
    },
  };
}

export function assertCrossDomainAllowed(input: {
  contract: OrchestrationContract;
  from_phase: AgentPhase;
  target_phase: AgentPhase;
}): void {
  if (
    input.contract.mode !== 'cross_domain' &&
    input.from_phase !== input.target_phase
  ) {
    throw new ApiError(
      'FORBIDDEN',
      `cross-domain delegation from ${input.from_phase} to ${input.target_phase} requires cross_domain mode`,
    );
  }
}

export function resolveCrossDomainArtifactPolicy(input: {
  contract: OrchestrationContract;
  from_phase: AgentPhase;
  target_phase: AgentPhase;
  artifact_key: ArtifactKey;
}): CrossDomainArtifactPolicy {
  assertCrossDomainAllowed(input);
  const crossDomain = input.contract.cross_domain;
  return {
    key: input.artifact_key,
    owner_phase: crossDomain.artifact_scope === 'target_phase_owner'
      ? input.target_phase
      : input.from_phase,
    read_boundary: crossDomain.read_boundary,
    draft_boundary: crossDomain.draft_boundary,
    write_boundary: crossDomain.write_boundary,
    approval_required: crossDomain.write_boundary === 'approval_required',
  };
}

export function arbitrateAgentConflicts(input: {
  signals: AgentConflictSignal[];
  contract?: OrchestrationContract;
}): ConflictArbitrationResult {
  const contract = input.contract ?? buildDefaultOrchestrationContract({
    phase: 'consultation',
  });
  return runArbitrationStrategy({
    signals: input.signals,
    contract,
  });
}
