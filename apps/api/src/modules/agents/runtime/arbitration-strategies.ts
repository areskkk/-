import { type AgentType } from '../../llm/model-registry.js';
import {
  type AgentConflictSignal,
  type ConflictArbitrationResult,
  type OrchestrationContract,
} from './orchestration-governance.js';

export type ArbitrationStrategy =
  | 'rule_based'
  | 'majority_vote'
  | 'weighted_vote'
  | 'veto'
  | 'consensus';

export type StrategyArbitrationResult = ConflictArbitrationResult & {
  strategy: ArbitrationStrategy;
  consensus_reached: boolean;
  votes: Array<{
    agent_type: AgentType;
    vote: 'accept' | 'reject' | 'abstain';
    weight: number;
    confidence: number;
  }>;
};

export function runArbitrationStrategy(input: {
  signals: AgentConflictSignal[];
  contract: OrchestrationContract;
  strategy?: ArbitrationStrategy;
}): StrategyArbitrationResult {
  const strategy = input.strategy ?? readStrategy(input.contract);
  if (strategy === 'majority_vote') {
    return majorityVote(input.signals, strategy);
  }
  if (strategy === 'weighted_vote') {
    return weightedVote(input.signals, strategy);
  }
  if (strategy === 'veto') {
    return veto(input.signals, input.contract, strategy);
  }
  if (strategy === 'consensus') {
    return consensus(input.signals, input.contract, strategy);
  }
  return ruleBased(input.signals, input.contract, strategy);
}

function ruleBased(
  signals: AgentConflictSignal[],
  contract: OrchestrationContract,
  strategy: ArbitrationStrategy,
): StrategyArbitrationResult {
  const votes = buildVotes(signals);
  const reasons = signals.flatMap((signal) => signal.reasons ?? []);
  const hasFallback = signals.some((signal) => signal.should_fallback);
  const hasApprovalConflict =
    signals.some((signal) => signal.approved === true) &&
    signals.some((signal) => signal.approved === false);
  const lowConfidence = signals.filter(
    (signal) => signal.confidence < contract.conflict_policy.low_confidence_threshold,
  );
  const confidence = minConfidence(signals);
  if (
    hasFallback ||
    lowConfidence.length > 0 ||
    (hasApprovalConflict && contract.conflict_policy.require_human_on_conflict)
  ) {
    return {
      strategy,
      decision: 'request_human',
      reasons: [
        ...reasons,
        ...(hasFallback ? ['agent_requested_fallback'] : []),
        ...(hasApprovalConflict ? ['agent_approval_conflict'] : []),
        ...lowConfidence.map((signal) => `low_confidence:${signal.agent_type}`),
      ],
      confidence,
      consensus_reached: false,
      votes,
    };
  }
  return {
    strategy,
    decision: 'accept',
    reasons,
    confidence,
    consensus_reached: true,
    votes,
  };
}

function majorityVote(
  signals: AgentConflictSignal[],
  strategy: ArbitrationStrategy,
): StrategyArbitrationResult {
  const votes = buildVotes(signals);
  const accept = votes.filter((vote) => vote.vote === 'accept').length;
  const reject = votes.filter((vote) => vote.vote === 'reject').length;
  if (accept === reject) {
    return requestHuman(strategy, signals, votes, ['majority_vote_tie']);
  }
  return {
    strategy,
    decision: accept > reject ? 'accept' : 'reject',
    reasons: signals.flatMap((signal) => signal.reasons ?? []),
    confidence: minConfidence(signals),
    consensus_reached: false,
    votes,
  };
}

function weightedVote(
  signals: AgentConflictSignal[],
  strategy: ArbitrationStrategy,
): StrategyArbitrationResult {
  const votes = buildVotes(signals);
  const accept = votes
    .filter((vote) => vote.vote === 'accept')
    .reduce((sum, vote) => sum + vote.weight, 0);
  const reject = votes
    .filter((vote) => vote.vote === 'reject')
    .reduce((sum, vote) => sum + vote.weight, 0);
  if (accept === reject) {
    return requestHuman(strategy, signals, votes, ['weighted_vote_tie']);
  }
  return {
    strategy,
    decision: accept > reject ? 'accept' : 'reject',
    reasons: signals.flatMap((signal) => signal.reasons ?? []),
    confidence: Math.max(accept, reject) / Math.max(1, accept + reject),
    consensus_reached: false,
    votes,
  };
}

function veto(
  signals: AgentConflictSignal[],
  contract: OrchestrationContract,
  strategy: ArbitrationStrategy,
): StrategyArbitrationResult {
  const votes = buildVotes(signals);
  const vetoSignals = signals.filter(
    (signal) => signal.should_fallback || signal.approved === false,
  );
  if (vetoSignals.length > 0) {
    return requestHuman(strategy, signals, votes, [
      'veto_signal_present',
      ...vetoSignals.map((signal) => `veto:${signal.agent_type}`),
    ]);
  }
  return ruleBased(signals, contract, strategy);
}

function consensus(
  signals: AgentConflictSignal[],
  contract: OrchestrationContract,
  strategy: ArbitrationStrategy,
): StrategyArbitrationResult {
  const votes = buildVotes(signals);
  const nonAbstain = votes.filter((vote) => vote.vote !== 'abstain');
  const allAccept = nonAbstain.length > 0 && nonAbstain.every((vote) => vote.vote === 'accept');
  const allReject = nonAbstain.length > 0 && nonAbstain.every((vote) => vote.vote === 'reject');
  if (!allAccept && !allReject) {
    return requestHuman(strategy, signals, votes, ['consensus_not_reached']);
  }
  const base = ruleBased(signals, contract, strategy);
  return {
    ...base,
    decision: allAccept ? base.decision : 'reject',
    consensus_reached: true,
    votes,
  };
}

function buildVotes(signals: AgentConflictSignal[]): StrategyArbitrationResult['votes'] {
  return signals.map((signal) => ({
    agent_type: signal.agent_type,
    vote: signal.should_fallback || signal.approved === false
      ? 'reject'
      : signal.approved === true || signal.confidence >= 0.7
        ? 'accept'
        : 'abstain',
    weight: Math.max(0, Math.min(1, signal.confidence)),
    confidence: Math.max(0, Math.min(1, signal.confidence)),
  }));
}

function requestHuman(
  strategy: ArbitrationStrategy,
  signals: AgentConflictSignal[],
  votes: StrategyArbitrationResult['votes'],
  reasons: string[],
): StrategyArbitrationResult {
  return {
    strategy,
    decision: 'request_human',
    reasons: [
      ...signals.flatMap((signal) => signal.reasons ?? []),
      ...reasons,
    ],
    confidence: minConfidence(signals),
    consensus_reached: false,
    votes,
  };
}

function minConfidence(signals: AgentConflictSignal[]): number {
  return signals.length === 0
    ? 0
    : Math.min(...signals.map((signal) => signal.confidence));
}

function readStrategy(contract: OrchestrationContract): ArbitrationStrategy {
  const policy = contract.conflict_policy as Record<string, unknown>;
  const strategy = policy.arbitration_strategy;
  return isArbitrationStrategy(strategy) ? strategy : 'rule_based';
}

function isArbitrationStrategy(value: unknown): value is ArbitrationStrategy {
  return value === 'rule_based' ||
    value === 'majority_vote' ||
    value === 'weighted_vote' ||
    value === 'veto' ||
    value === 'consensus';
}
