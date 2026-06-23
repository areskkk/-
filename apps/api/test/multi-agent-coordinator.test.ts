import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors/http-error.js';
import { type AgentGraphState } from '../src/modules/agents/agents.types.js';
import { aggregateSubagentResults } from '../src/modules/agents/runtime/result-aggregator.js';
import { verifySubagentResult } from '../src/modules/agents/runtime/result-verifier.js';
import {
  assertSubagentPermission,
  buildSubagentPermissionScope,
  normalizeDelegatedSubagents,
} from '../src/modules/agents/runtime/subagent-registry.js';

describe('multi-agent coordinator P4 contracts', () => {
  it('normalizes coordinator delegated subagents and rejects unauthorized workers', () => {
    expect(normalizeDelegatedSubagents({
      action: 'delegate_subagent',
      subagents: ['retrieval_planner', 'retrieval_planner', 'policy_analysis'],
      task_input: { objective: 'ground policy answer' },
    }, 'consultation')).toEqual(['retrieval_planner', 'policy_analysis']);

    expect(() => normalizeDelegatedSubagents({
      action: 'delegate_subagent',
      subagents: ['document_vision'],
      task_input: {},
    }, 'consultation')).toThrow(ApiError);
  });

  it('binds subagent permissions to the current business scope', () => {
    const consultationScope = buildSubagentPermissionScope({
      phase: 'consultation',
      policy_id: 'policy-1',
    });
    expect(() => assertSubagentPermission(
      consultationScope,
      'retrieval_planner',
    )).not.toThrow();
    expect(() => assertSubagentPermission(
      consultationScope,
      'document_vision',
    )).toThrow(ApiError);

    const applicationScope = buildSubagentPermissionScope({
      phase: 'application',
      application: {
        item_id: 'item-1',
        application_id: 'app-1',
        policy_id: 'policy-1',
      },
    });
    expect(applicationScope).toMatchObject({
      entrypoint: 'application',
      item_id: 'item-1',
      application_id: 'app-1',
      policy_id: 'policy-1',
    });
    expect(() => assertSubagentPermission(
      applicationScope,
      'document_vision',
    )).not.toThrow();
  });

  it('verifier rejects invalid subagent output contracts', () => {
    expect(verifySubagentResult({
      agent_type: 'policy_analysis',
      output: {
        result: 'eligible_if_conditions_met',
        explanation: 'Citation supports the answer.',
        confidence: 0.8,
      },
    }).output).toMatchObject({
      result: 'eligible_if_conditions_met',
      confidence: 0.8,
    });

    expect(() => verifySubagentResult({
      agent_type: 'risk_judge',
      output: {
        approved: true,
        reasons: [],
        confidence: 0.8,
      },
    })).toThrow(ApiError);
  });

  it('rejects policy analysis missing_fields with the wrong type', () => {
    expect(() => verifySubagentResult({
      agent_type: 'policy_analysis',
      output: {
        result: 'eligible_if_conditions_met',
        explanation: 'Citation supports the answer.',
        missing_fields: 'business_license',
        confidence: 0.8,
      },
    })).toThrow(ApiError);
  });

  it('rejects document vision risk_items with invalid element structure', () => {
    expect(() => verifySubagentResult({
      agent_type: 'document_vision',
      output: {
        risk_items: [{
          field: 'ocr.credit_code',
          severity: 'critical',
          reason: 'Unsupported severity.',
        }],
        usable_as_hard_evidence: false,
        confidence: 0.8,
      },
    })).toThrow(ApiError);

    expect(() => verifySubagentResult({
      agent_type: 'document_vision',
      output: {
        risk_items: [{
          severity: 'high',
          reason: 'Missing field key.',
        }],
        usable_as_hard_evidence: false,
        confidence: 0.8,
      },
    })).toThrow(ApiError);
  });

  it('aggregates fan-out and verifier fan-in into runtime audit state', () => {
    const state: AgentGraphState = {
      run_id: 'run-1',
      trace_id: 'trace-1',
      actor_id: 'actor-1',
      entrypoint: 'consultation',
      input: {
        question: 'Can I apply?',
        policy_id: 'policy-1',
      },
      runtime: {
        phase: 'consultation',
        active_agent: 'supervisor',
      },
      errors: [],
    };

    const nextState = aggregateSubagentResults({
      state,
      phase: 'consultation',
      subagents: ['retrieval_planner', 'policy_analysis'],
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
      },
      outputs: [
        {
          agent_type: 'retrieval_planner',
          output: {
            query: 'Can I apply?',
            policy_id: 'policy-1',
            limit: 3,
          },
        },
        {
          agent_type: 'policy_analysis',
          output: {
            result: 'eligible_if_conditions_met',
            matched_conditions: [],
            missing_fields: [],
            explanation: 'Grounded by citations.',
            confidence: 0.82,
          },
        },
      ],
      verifier_output: {
        approved: true,
        should_fallback: false,
        reasons: [],
        confidence: 0.86,
      },
    });

    expect(nextState.runtime?.coordinator).toMatchObject({
      agent_type: 'supervisor',
      delegated_subagents: ['retrieval_planner', 'policy_analysis'],
      fanout_count: 2,
      fanout_mode: 'sequential',
      fanin_strategy: 'risk_judge_verifier',
      fanin_completed: true,
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
        allowed_subagents: ['retrieval_planner', 'policy_analysis', 'risk_judge'],
      },
      budget: {
        max_subagents: 3,
        max_turns_per_subagent: 1,
        verifier_required: true,
      },
    });
    expect(nextState.runtime?.subagents).toHaveLength(2);
    expect(nextState.runtime?.subagents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_type: 'risk_judge' }),
    ]));
    expect(nextState.runtime?.verifier).toMatchObject({
      agent_type: 'risk_judge',
      result_kind: 'final_verifier_result',
      status: 'completed',
      budget: {
        max_turns: 1,
        required: true,
      },
    });
  });

  it('keeps final verifier result as the single authority over raw risk_judge output', () => {
    const nextState = aggregateSubagentResults({
      state: {
        run_id: 'run-raw-verifier',
        trace_id: 'trace-raw-verifier',
        actor_id: 'actor-raw-verifier',
        entrypoint: 'consultation',
        current_node: 'runtime_delegate_subagent',
        input: {},
        errors: [],
      },
      phase: 'consultation',
      subagents: ['retrieval_planner'],
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: 'policy-1',
      },
      subagent_results: [
        {
          agent_type: 'retrieval_planner',
          status: 'completed',
          runtime: {
            parent_run_id: 'run-raw-verifier',
            task_id: 'retrieval_planner:1',
            runtime_id: 'subagent:run-raw-verifier:retrieval_planner:1',
            checkpoint_id: 'subagent:run-raw-verifier:retrieval_planner:1:checkpoint:latest',
            resume_token: 'subagent:run-raw-verifier:retrieval_planner:1:resume',
          },
          permission_scope: {
            entrypoint: 'consultation',
            policy_id: 'policy-1',
          },
          budget: {
            max_turns: 1,
            max_tool_calls: 0,
          },
          capabilities: {
            independent_tool_loop: false,
            can_delegate: false,
            can_request_human: true,
          },
          turn_count: 1,
          tool_call_count: 0,
          output: {
            query: 'policy',
            policy_id: 'policy-1',
            limit: 3,
          },
        },
        {
          agent_type: 'risk_judge',
          status: 'completed',
          runtime: {
            parent_run_id: 'run-raw-verifier',
            task_id: 'risk_judge:verifier',
            runtime_id: 'subagent:run-raw-verifier:risk_judge:verifier',
            checkpoint_id: 'subagent:run-raw-verifier:risk_judge:verifier:checkpoint:latest',
            resume_token: 'subagent:run-raw-verifier:risk_judge:verifier:resume',
          },
          permission_scope: {
            entrypoint: 'consultation',
            policy_id: 'policy-1',
          },
          budget: {
            max_turns: 1,
            max_tool_calls: 0,
          },
          capabilities: {
            independent_tool_loop: false,
            can_delegate: false,
            can_request_human: true,
          },
          turn_count: 1,
          tool_call_count: 0,
          output: {
            approved: true,
            should_fallback: false,
            reasons: ['raw_verifier_output'],
            confidence: 0.9,
          },
        },
      ],
      verifier_output: {
        approved: false,
        should_fallback: true,
        reasons: ['agent_approval_conflict'],
        confidence: 0.64,
      },
    });

    expect(nextState.runtime?.subagents).toHaveLength(1);
    expect(nextState.runtime?.subagents?.[0].runtime).toMatchObject({
      runtime_id: 'subagent:run-raw-verifier:retrieval_planner:1',
      checkpoint_id: 'subagent:run-raw-verifier:retrieval_planner:1:checkpoint:latest',
      resume_token: 'subagent:run-raw-verifier:retrieval_planner:1:resume',
    });
    expect(nextState.runtime?.subagents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_type: 'risk_judge' }),
    ]));
    expect(nextState.runtime?.verifier).toMatchObject({
      agent_type: 'risk_judge',
      result_kind: 'final_verifier_result',
      final_judge: {
        approved: false,
        should_fallback: true,
        reasons: ['agent_approval_conflict'],
        confidence: 0.64,
      },
    });
  });
});
