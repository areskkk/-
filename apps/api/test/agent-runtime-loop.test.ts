import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors/http-error.js';
import { validateAgentAction } from '../src/modules/agents/runtime/agent-action-schema.js';
import {
  assertPhaseActionAllowed,
  assertPhaseAgentAllowed,
} from '../src/modules/agents/runtime/phase-policy.js';
import { LlmError } from '../src/modules/llm/llm.types.js';

const context = {
  agent_type: 'supervisor' as const,
  model: 'test-model',
  trace_id: 'runtime-loop-test',
};

describe('agent runtime loop contracts', () => {
  it('validates one action json object per turn', () => {
    const action = validateAgentAction({
      ...context,
      json: {
        action: 'call_tool',
        tool_name: 'rag.search',
        tool_input: { query: 'stable subsidy' },
      },
    });

    expect(action).toEqual({
      action: 'call_tool',
      tool_name: 'rag.search',
      tool_input: { query: 'stable subsidy' },
      rationale: undefined,
    });
  });

  it('preserves cancelled stop_run intent from the model action', () => {
    const action = validateAgentAction({
      ...context,
      json: {
        action: 'stop_run',
        reason: 'user cancelled the runtime task',
        status: 'cancelled',
      },
    });

    expect(action).toEqual({
      action: 'stop_run',
      reason: 'user cancelled the runtime task',
      status: 'cancelled',
    });
  });

  it('rejects malformed or unsupported runtime actions', () => {
    expect(() => validateAgentAction({
      ...context,
      json: { action: 'call_tool' },
    })).toThrow(LlmError);

    expect(() => validateAgentAction({
      ...context,
      json: { action: 'freeform_shell', command: 'rm -rf .' },
    })).toThrow(LlmError);
  });

  it('guards consultation phase actions and tools', () => {
    expect(() => assertPhaseActionAllowed({
      phase: 'consultation',
      action: {
        action: 'call_tool',
        tool_name: 'rag.search',
        tool_input: { query: 'stable subsidy' },
      },
    })).not.toThrow();

    expect(() => assertPhaseActionAllowed({
      phase: 'consultation',
      action: {
        action: 'call_tool',
        tool_name: 'ocr.material_evidence.read',
        tool_input: { application_id: 'app-1' },
      },
    })).toThrow(ApiError);
  });

  it('guards application phase tools', () => {
    expect(() => assertPhaseAgentAllowed({
      phase: 'application',
      agent_type: 'math_verification',
    })).not.toThrow();

    expect(() => assertPhaseActionAllowed({
      phase: 'application',
      action: {
        action: 'call_tool',
        tool_name: 'ocr.material_evidence.read',
        tool_input: { application_id: 'app-1' },
      },
    })).not.toThrow();

    expect(() => assertPhaseActionAllowed({
      phase: 'application',
      action: {
        action: 'call_tool',
        tool_name: 'rag.search',
        tool_input: { query: 'policy' },
      },
    })).toThrow(ApiError);
  });

  it('allows phase coordinators to delegate only approved subagents', () => {
    expect(() => assertPhaseActionAllowed({
      phase: 'consultation',
      action: {
        action: 'delegate_subagent',
        subagents: ['retrieval_planner', 'policy_analysis'],
        task_input: { objective: 'ground policy answer' },
      },
    })).not.toThrow();

    expect(() => assertPhaseActionAllowed({
      phase: 'application',
      action: {
        action: 'delegate_subagent',
        subagents: ['document_vision', 'math_verification'],
        task_input: { objective: 'verify application evidence' },
      },
    })).not.toThrow();

    expect(() => assertPhaseActionAllowed({
      phase: 'review',
      action: {
        action: 'delegate_subagent',
        subagents: ['document_vision', 'math_verification'],
        task_input: { objective: 'review draft evidence' },
      },
    })).not.toThrow();

    expect(() => assertPhaseActionAllowed({
      phase: 'consultation',
      action: {
        action: 'delegate_subagent',
        subagents: ['document_vision'],
        task_input: {},
      },
    })).toThrow(ApiError);

    expect(() => assertPhaseActionAllowed({
      phase: 'application',
      action: {
        action: 'delegate_subagent',
        subagents: ['policy_analysis'],
        task_input: {},
      },
    })).toThrow(ApiError);

    expect(() => assertPhaseActionAllowed({
      phase: 'review',
      action: {
        action: 'delegate_subagent',
        subagents: ['review'],
        task_input: {},
      },
    })).toThrow(ApiError);
  });

  it('parses target_phase for cross-domain delegation actions', () => {
    const action = validateAgentAction({
      ...context,
      json: {
        action: 'delegate_subagent',
        target_phase: 'review',
        subagents: ['document_vision'],
        task_input: {
          objective: 'cross-domain evidence review',
        },
      },
    });

    expect(action).toMatchObject({
      action: 'delegate_subagent',
      target_phase: 'review',
      subagents: ['document_vision'],
    });
  });

  it('checks delegated subagents against target_phase when present', () => {
    expect(() => assertPhaseActionAllowed({
      phase: 'consultation',
      action: {
        action: 'delegate_subagent',
        target_phase: 'review',
        subagents: ['document_vision'],
        task_input: {},
      },
    })).not.toThrow();

    expect(() => assertPhaseActionAllowed({
      phase: 'consultation',
      action: {
        action: 'delegate_subagent',
        target_phase: 'review',
        subagents: ['policy_analysis'],
        task_input: {},
      },
    })).toThrow(ApiError);
  });
});
