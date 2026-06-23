import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors/http-error.js';
import { requireApprovalForSideEffect } from '../src/modules/agents/runtime/approval-gate.js';
import { buildDefaultOrchestrationContract } from '../src/modules/agents/runtime/orchestration-governance.js';
import {
  decideToolSideEffect,
  requireToolSemanticDefinition,
} from '../src/modules/agents/runtime/tool-semantic-registry.js';
import {
  beginSagaStep,
  completeSagaStep,
  failSagaStep,
  readSagaSteps,
} from '../src/modules/agents/runtime/saga-orchestrator.js';
import { runCompensationForFailedTool } from '../src/modules/agents/runtime/compensation-runner.js';
import { runArbitrationStrategy } from '../src/modules/agents/runtime/arbitration-strategies.js';
import { type AgentGraphState } from '../src/modules/agents/agents.types.js';

function baseState(): AgentGraphState {
  return {
    run_id: 'run-p8',
    trace_id: 'trace-p8',
    actor_id: 'actor-p8',
    entrypoint: 'consultation',
    input: {
      question: 'Can this tool run?',
      policy_id: 'policy-1',
    },
    errors: [],
  };
}

describe('P8 tool semantics, saga compensation, and arbitration strategies', () => {
  it('decides side-effect policy from tool semantic registry', () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'consultation',
    });

    const decision = decideToolSideEffect({
      tool_name: 'rag.search',
      contract,
    });

    expect(decision).toMatchObject({
      tool_name: 'rag.search',
      semantic_class: 'read_only',
      side_effect_class: 'read_only',
      allowed: true,
      approval_required: false,
      compensation_required: false,
      idempotent: true,
    });
  });

  it('records saga lifecycle and compensation result', () => {
    const semantic = {
      ...requireToolSemanticDefinition('rag.search'),
      semantic_class: 'external_mutation' as const,
      side_effect_class: 'approval_required' as const,
      compensatable: true,
      compensation_action: 'rollback:test-tool',
    };
    const decision = decideToolSideEffect({
      tool_name: 'rag.search',
      contract: buildDefaultOrchestrationContract({
        phase: 'consultation',
      }),
      semantic,
    });
    const begun = beginSagaStep({
      state: baseState(),
      tool_name: 'rag.search',
      semantic: decision,
    });
    const failed = failSagaStep({
      state: begun.state,
      step_id: begun.step.step_id,
      reason: 'tool failed after mutation',
    });
    const compensated = runCompensationForFailedTool({
      state: failed,
      step_id: begun.step.step_id,
      semantic,
      error_message: 'tool failed after mutation',
    });

    expect(compensated.compensated).toBe(true);
    expect(readSagaSteps(compensated.state)[0]).toMatchObject({
      status: 'compensated',
      compensation: {
        status: 'completed',
        action: 'rollback:test-tool',
      },
    });
  });

  it('turns tool semantic approval requirements into explicit approval requests', () => {
    const semantic = {
      ...requireToolSemanticDefinition('rag.search'),
      semantic_class: 'approval_required' as const,
      side_effect_class: 'read_only' as const,
    };
    const decision = decideToolSideEffect({
      tool_name: 'rag.search',
      contract: buildDefaultOrchestrationContract({
        phase: 'consultation',
      }),
      semantic,
    });

    const state = requireApprovalForSideEffect({
      state: baseState(),
      side_effect_class: decision.approval_required
        ? 'approval_required'
        : decision.side_effect_class,
      reason: 'semantic approval required',
      context: {
        tool_name: decision.tool_name,
        semantic: decision,
      },
    });

    expect((state.control as { approval_requests: Array<Record<string, unknown>> }).approval_requests[0])
      .toMatchObject({
        status: 'pending',
        side_effect_class: 'approval_required',
        reason: 'semantic approval required',
      });
  });

  it('marks read-only saga steps as completed without compensation', () => {
    const decision = decideToolSideEffect({
      tool_name: 'ocr.material_evidence.read',
      contract: buildDefaultOrchestrationContract({
        phase: 'application',
      }),
    });
    const begun = beginSagaStep({
      state: baseState(),
      tool_name: 'ocr.material_evidence.read',
      semantic: decision,
    });
    const completed = completeSagaStep({
      state: begun.state,
      step_id: begun.step.step_id,
    });

    expect(readSagaSteps(completed)[0]).toMatchObject({
      status: 'completed',
      compensation: {
        status: 'not_required',
      },
    });
  });

  it('rejects saga updates for unknown steps instead of creating synthetic ledger entries', () => {
    expect(() => completeSagaStep({
      state: baseState(),
      step_id: 'missing-step',
    })).toThrow(ApiError);
  });

  it('supports weighted-vote arbitration before human escalation', () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'review',
    });
    contract.conflict_policy.arbitration_strategy = 'weighted_vote';

    const result = runArbitrationStrategy({
      contract,
      signals: [
        {
          agent_type: 'document_vision',
          approved: true,
          confidence: 0.9,
        },
        {
          agent_type: 'math_verification',
          approved: true,
          confidence: 0.8,
        },
        {
          agent_type: 'risk_judge',
          approved: false,
          confidence: 0.2,
          reasons: ['minor verifier disagreement'],
        },
      ],
    });

    expect(result).toMatchObject({
      strategy: 'weighted_vote',
      decision: 'accept',
      consensus_reached: false,
    });
    expect(result.votes).toHaveLength(3);
  });

  it('requires human when consensus strategy cannot converge', () => {
    const contract = buildDefaultOrchestrationContract({
      phase: 'review',
    });
    contract.conflict_policy.arbitration_strategy = 'consensus';

    const result = runArbitrationStrategy({
      contract,
      signals: [
        {
          agent_type: 'document_vision',
          approved: true,
          confidence: 0.9,
        },
        {
          agent_type: 'risk_judge',
          approved: false,
          confidence: 0.9,
        },
      ],
    });

    expect(result).toMatchObject({
      strategy: 'consensus',
      decision: 'request_human',
      consensus_reached: false,
      reasons: expect.arrayContaining(['consensus_not_reached']),
    });
  });
});
