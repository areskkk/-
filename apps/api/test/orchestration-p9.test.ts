import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors/http-error.js';
import { type AgentGraphState } from '../src/modules/agents/agents.types.js';
import {
  createWorkflowInstance,
  evaluateWorkflowSla,
  markWorkflowWaitResumable,
  readWorkflow,
  registerWorkflowWait,
  resumeWorkflowWait,
} from '../src/modules/agents/runtime/platform-workflow.js';
import {
  assertReplayTraceDeterministic,
  buildActionReplayTrace,
  evaluateSlaGate,
} from '../src/modules/agents/runtime/platform-observability.js';
import {
  assertTenantCapabilityAllowed,
  buildTenantPolicy,
  discoverCapabilities,
  listPluginRegistry,
} from '../src/modules/agents/runtime/platform-ecosystem.js';
import { buildDelegationTaskGraph } from '../src/modules/agents/runtime/task-graph-planner.js';
import { type AgentRunRow } from '../src/modules/agents/agents.types.js';

function baseState(): AgentGraphState {
  return {
    run_id: 'run-p9',
    trace_id: 'trace-p9',
    actor_id: 'actor-p9',
    entrypoint: 'consultation',
    input: {
      question: 'Need long running workflow',
    },
    errors: [],
  };
}

describe('P9 platform productization contracts', () => {
  it('creates workflow waits and resumes them through stable tokens', () => {
    const graph = buildDelegationTaskGraph({
      phase: 'consultation',
      goal: 'long running policy workflow',
      subagents: ['retrieval_planner'],
      fanout_mode: 'sequential',
      include_verifier: true,
    });
    const initialized = createWorkflowInstance({
      state: baseState(),
      graph,
      sla: {
        timeout_minutes: 10,
        escalation_policy: 'manual_review',
      },
    });
    const waiting = registerWorkflowWait({
      state: initialized,
      task_id: 'risk_judge:verifier',
      reason: 'human_resume',
      expires_at: '2026-06-17T00:10:00.000Z',
      payload: {
        approval_id: 'approval-p9',
      },
    });
    const wait = readWorkflow(waiting)?.waits[0];
    expect(wait).toMatchObject({
      task_id: 'risk_judge:verifier',
      status: 'waiting',
      reason: 'human_resume',
    });

    const resumable = markWorkflowWaitResumable({
      state: waiting,
      resume_token: wait?.resume_token ?? '',
      payload: {
        approved: true,
      },
    });
    const resumed = resumeWorkflowWait({
      state: resumable,
      resume_token: wait?.resume_token ?? '',
    });

    expect(readWorkflow(resumed)?.waits[0]).toMatchObject({
      status: 'resumed',
    });
    expect(readWorkflow(resumed)?.graph.nodes.find((node) => node.task_id === 'risk_judge:verifier'))
      .toMatchObject({
        status: 'completed',
      });
  });

  it('evaluates workflow wait SLA and escalates expired waits', () => {
    const graph = buildDelegationTaskGraph({
      phase: 'review',
      goal: 'review wait',
      subagents: ['document_vision'],
      fanout_mode: 'sequential',
      include_verifier: true,
    });
    const state = registerWorkflowWait({
      state: createWorkflowInstance({
        state: baseState(),
        graph,
        sla: {
          timeout_minutes: 1,
          escalation_policy: 'manual_review',
        },
      }),
      task_id: 'risk_judge:verifier',
      reason: 'timer',
      expires_at: '2026-06-17T00:00:00.000Z',
    });
    const evaluated = evaluateWorkflowSla({
      state,
      now: new Date('2026-06-17T00:02:00.000Z'),
    });

    expect(readWorkflow(evaluated)?.waits[0]).toMatchObject({
      status: 'escalated',
    });
  });

  it('builds deterministic action-level replay and applies SLA eval gates', () => {
    const run: AgentRunRow = {
      run_id: 'run-p9',
      actor_id: 'actor-p9',
      entrypoint: 'consultation',
      status: 'completed',
      current_node: 'final',
      state: baseState(),
      idempotency_key: null,
      trace_id: 'trace-p9',
      error_message: null,
      started_at: '2026-06-17T00:00:00.000Z',
      interrupted_at: null,
      completed_at: '2026-06-17T00:00:02.000Z',
      updated_at: '2026-06-17T00:00:02.000Z',
      version: 1,
    };
    const replay = buildActionReplayTrace({
      run,
      steps: [{
        step_id: 'step-1',
        run_id: run.run_id,
        node_name: 'runtime_call_tool',
        agent_type: 'supervisor',
        model_name: null,
        prompt_template_id: null,
        status: 'completed',
        input: { action: 'call_tool' },
        output: { ok: true },
        tool_calls: [],
        token_usage: {},
        error_message: null,
        started_at: '2026-06-17T00:00:00.000Z',
        completed_at: '2026-06-17T00:00:01.000Z',
      }],
      tool_calls: [{
        tool_call_id: 'tool-1',
        run_id: run.run_id,
        step_id: 'step-1',
        tool_name: 'rag.search',
        input: { query: 'policy' },
        output: { citation_count: 1 },
        status: 'completed',
        error_message: null,
        started_at: '2026-06-17T00:00:00.500Z',
        completed_at: '2026-06-17T00:00:00.800Z',
      }],
    });

    expect(replay).toMatchObject({
      version: 'action_replay.v1',
      run_id: 'run-p9',
      actions: [
        { kind: 'step', order: 1 },
        { kind: 'tool_call', order: 2 },
      ],
    });
    expect(() => assertReplayTraceDeterministic(replay)).not.toThrow();

    const gate = evaluateSlaGate({
      metrics: {
        run_rates: {
          failed_rate: 0.02,
          interrupted_rate: 0.1,
        },
        fallback_sla: {
          overdue_count: 2,
        },
        queue_depth: {
          queued: 5,
        },
      },
      policy: {
        max_failed_rate: 0.05,
        max_interrupted_rate: 0.2,
        max_fallback_overdue_count: 3,
        max_queue_depth: 10,
      },
    });
    expect(gate).toMatchObject({
      version: 'agent_eval_gate.v1',
      status: 'pass',
    });
  });

  it('enforces tenant isolation and exposes capability and plugin discovery', () => {
    const tenant = buildTenantPolicy({
      tenant_id: 'tenant-a',
      allowed_agents: ['retrieval_planner'],
      allowed_tools: ['rag.search'],
      plugin_allowlist: ['core.agent-runtime'],
    });

    expect(() => assertTenantCapabilityAllowed({
      tenant,
      agent_type: 'retrieval_planner',
      tool_name: 'rag.search',
      plugin_id: 'core.agent-runtime',
    })).not.toThrow();
    expect(() => assertTenantCapabilityAllowed({
      tenant,
      agent_type: 'document_vision',
    })).toThrow(ApiError);

    const capabilities = discoverCapabilities({ tenant });
    expect(capabilities.find((item) => item.capability_id === 'agent:retrieval_planner'))
      .toMatchObject({ allowed: true });
    expect(capabilities.find((item) => item.capability_id === 'tool:ocr.material_evidence.read'))
      .toMatchObject({ allowed: false });

    expect(listPluginRegistry({ tenant })).toEqual([
      expect.objectContaining({
        plugin_id: 'core.agent-runtime',
        enabled: true,
        sandbox: {
          network: 'restricted',
          filesystem: 'none',
          side_effects: 'registry_declared_only',
        },
      }),
    ]);
  });
});
