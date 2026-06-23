import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setLlmClientForTesting, resetLlmClientForTesting } from '../src/modules/llm/llm-provider.js';
import { FakeLlmClient } from '../src/modules/llm/fake-llm.client.js';
import {
  canConnectDatabase,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';

process.env.ALLOW_DEV_STUB_AUTH = 'true';
process.env.RAG_SERVICE_BASE_URL = '';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;
const authHeader = { authorization: 'Bearer dev:batch18-user:system_admin' };

async function createPolicyForRag(input: {
  title: string;
  content: string;
}) {
  const rows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, source_name, source_url, status, version, content)
      VALUES ($1, 'manual_import', 'Batch18 Source', 'https://example.test/policy', 'effective', 'v1', $2)
      RETURNING policy_id::text
    `,
    [input.title, input.content],
  );
  const policyId = rows[0].policy_id;
  await getRows(
    'INSERT INTO policy_ai_whitelist (policy_id, enabled) VALUES ($1, true)',
    [policyId],
  );
  return policyId;
}

function agentFakeClient(input: {
  toolArguments?: Record<string, unknown>;
  policyAnswer?: string;
} = {}) {
  const toolArguments = input.toolArguments ?? {
    query: 'stable enterprise subsidy furniture revenue',
    limit: 3,
  };
  return new FakeLlmClient([
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'rag.search',
        tool_input: toolArguments,
        rationale: 'Need policy citations before answering.',
      }),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    {
      content: JSON.stringify({
        action: 'respond_final',
        answer: input.policyAnswer ?? 'Enterprises may apply when the cited subsidy policy conditions are met.',
        confidence: 0.88,
      }),
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    },
  ]);
}

function requestHumanFakeClient(input: {
  toolArguments?: Record<string, unknown>;
  reason?: string;
} = {}) {
  const toolArguments = input.toolArguments ?? {
    query: 'stable enterprise subsidy furniture revenue',
    limit: 3,
  };
  return new FakeLlmClient([
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'rag.search',
        tool_input: toolArguments,
      }),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    {
      content: JSON.stringify({
        action: 'request_human',
        reason: input.reason ?? 'policy_qa_no_citation',
        context: {
          citation_count: 0,
        },
      }),
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    },
  ]);
}

function consultationDelegateFakeClient() {
  return new FakeLlmClient([
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'rag.search',
        tool_input: {
          query: 'stable enterprise subsidy furniture revenue',
        },
      }),
    },
    {
      content: JSON.stringify({
        action: 'delegate_subagent',
        subagents: ['retrieval_planner', 'policy_analysis'],
        task_input: {
          objective: 'Ground the answer with retrieved citations.',
        },
      }),
    },
    {
      content: JSON.stringify({
        result: 'eligible_if_conditions_met',
        matched_conditions: ['stable enterprise subsidy citation exists'],
        missing_fields: [],
        explanation: 'Retrieved citation supports the answer.',
        answer: 'The cited policy may apply if conditions are met.',
        confidence: 0.86,
      }),
    },
    {
      content: JSON.stringify({
        approved: true,
        should_fallback: false,
        reasons: [],
        confidence: 0.82,
      }),
    },
    {
      content: JSON.stringify({
        action: 'respond_final',
        answer: 'The cited stable enterprise subsidy policy may apply if conditions are met.',
        confidence: 0.88,
      }),
    },
  ]);
}

function consultationDelegateExplicitVerifierFakeClient() {
  return new FakeLlmClient([
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'rag.search',
        tool_input: {
          query: 'stable enterprise subsidy furniture revenue',
        },
      }),
    },
    {
      content: JSON.stringify({
        action: 'delegate_subagent',
        subagents: ['retrieval_planner', 'policy_analysis', 'risk_judge'],
        task_input: {
          objective: 'Ground the answer and verify risk once.',
        },
      }),
    },
    {
      content: JSON.stringify({
        result: 'eligible_if_conditions_met',
        matched_conditions: ['stable enterprise subsidy citation exists'],
        missing_fields: [],
        explanation: 'Retrieved citation supports the answer.',
        answer: 'The cited policy may apply if conditions are met.',
        confidence: 0.86,
      }),
    },
    {
      content: JSON.stringify({
        approved: true,
        should_fallback: false,
        reasons: [],
        confidence: 0.82,
      }),
    },
    {
      content: JSON.stringify({
        action: 'respond_final',
        answer: 'The cited stable enterprise subsidy policy may apply if conditions are met.',
        confidence: 0.88,
      }),
    },
  ]);
}

describeIfDb('batch18 policy consultation multi-agent', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    process.env.AGENT_RUN_ASYNC_ENABLED = 'false';
    process.env.AGENT_ORCHESTRATION_ENABLED = 'true';
    await truncateBusinessTables();
  });

  afterEach(() => {
    process.env.AGENT_ORCHESTRATION_ENABLED = 'false';
    resetLlmClientForTesting();
  });

  it('routes policy QA through multi-agent graph with RAG as a tool and visible agent outputs', async () => {
    const app = await buildApp();
    const fakeClient = agentFakeClient();
    setLlmClientForTesting(fakeClient);
    const policyId = await createPolicyForRag({
      title: 'Stable Enterprise Subsidy',
      content: 'Stable enterprise subsidy supports furniture companies with revenue and employee conditions.',
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyId}/index`,
      headers: authHeader,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: authHeader,
      payload: {
        question: 'Can a furniture company apply for stable enterprise subsidy?',
        policy_id: policyId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('answered');
    expect(response.json().data.citations).toHaveLength(1);
    expect(response.json().data.answer).toContain('Citation: Stable Enterprise Subsidy v1');
    expect(response.json().data.scoring.agent_orchestration_enabled).toBe(true);
    expect(response.json().data.scoring.run_id).toEqual(expect.any(String));
    expect(fakeClient.getCallCount()).toBe(2);
    expect(fakeClient.getRequests()[0].messages[0].content)
      .toContain('delegate_subagent');

    const runId = response.json().data.scoring.run_id as string;
    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}/steps`,
      headers: authHeader,
    });
    const stepNames = steps.json().data.steps.map((step: { node_name: string }) => step.node_name);
    expect(stepNames).toEqual([
      'runtime_call_tool',
      'runtime_final',
    ]);
    const llmSteps = steps.json().data.steps.filter(
      (step: { agent_type: string }) => step.agent_type !== 'tool' && step.agent_type !== 'final',
    );
    expect(llmSteps).toHaveLength(2);
    expect(llmSteps.every((step: { input: { action?: string } }) => Boolean(step.input.action))).toBe(true);
    expect(llmSteps.every((step: { output: Record<string, unknown> }) => Object.keys(step.output).length > 0)).toBe(true);
    expect(steps.json().data.tool_calls).toHaveLength(1);
    expect(steps.json().data.tool_calls[0]).toMatchObject({
      tool_name: 'rag.search',
      status: 'completed',
    });
    const retrievalStep = steps.json().data.steps.find(
      (step: { node_name: string }) => step.node_name === 'runtime_call_tool',
    );
    expect(retrievalStep.tool_calls).toHaveLength(1);
    const runRows = await getRows<{ state: Record<string, unknown> }>(
      'SELECT state FROM agent_runs WHERE run_id = $1',
      [runId],
    );
    expect((runRows[0].state.runtime as Record<string, unknown>).phase).toBe('consultation');
    expect((runRows[0].state.runtime as Record<string, unknown>).turn_count).toBe(2);
    await app.close();
  });

  it('falls back when multi-agent policy QA has no citation', async () => {
    const app = await buildApp();
    setLlmClientForTesting(requestHumanFakeClient());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: authHeader,
      payload: {
        question: 'No matching policy should produce fallback',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('manual_review');
    expect(response.json().data.citations).toHaveLength(0);
    expect(response.json().data.fallback_task.task_id).toEqual(expect.any(String));

    const runId = response.json().data.scoring.run_id as string;
    const runRows = await getRows<{ state: Record<string, unknown> }>(
      'SELECT state FROM agent_runs WHERE run_id = $1',
      [runId],
    );
    const control = runRows[0].state.control as {
      approval_requests: Array<Record<string, unknown>>;
    };
    expect(control.approval_requests).toHaveLength(1);
    expect(control.approval_requests[0]).toMatchObject({
      status: 'pending',
      side_effect_class: 'approval_required',
      reason: 'policy_qa_no_citation',
    });

    const fallbackRows = await getRows<{ run_id: string; source_type: string; reason: string }>(
      'SELECT run_id, source_type, reason FROM fallback_tasks WHERE run_id = $1',
      [runId],
    );
    expect(fallbackRows).toEqual([{
      run_id: runId,
      source_type: 'agent_run',
      reason: 'policy_qa_no_citation',
    }]);
    await app.close();
  });

  it('forces native rag.search tool calls into the consultation run policy scope', async () => {
    const app = await buildApp();
    setLlmClientForTesting(agentFakeClient({
      toolArguments: {
        query: 'shared subsidy phrase',
      },
      policyAnswer: 'Only scoped policy A should be cited.',
    }));
    const policyA = await createPolicyForRag({
      title: 'Scoped Policy A',
      content: 'shared subsidy phrase only policy A should be returned when scoped.',
    });
    const policyB = await createPolicyForRag({
      title: 'Unscoped Policy B',
      content: 'shared subsidy phrase policy B would match without policy scope.',
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyA}/index`,
      headers: authHeader,
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyB}/index`,
      headers: authHeader,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: authHeader,
      payload: {
        question: 'Which scoped policy applies to the shared subsidy phrase?',
        policy_id: policyA,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('answered');
    expect(response.json().data.citations).toHaveLength(1);
    expect(response.json().data.citations[0].policy_id).toBe(policyA);
    expect(response.json().data.citations[0].title).toBe('Scoped Policy A');

    const runId = response.json().data.scoring.run_id as string;
    const toolCalls = await getRows<{ input: Record<string, unknown> }>(
      `
        SELECT input
        FROM agent_tool_calls
        WHERE run_id = $1 AND tool_name = 'rag.search'
      `,
      [runId],
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].input).toMatchObject({
      policy_id: policyA,
      limit: 3,
      create_fallback_task: false,
    });
    await app.close();
  });

  it('does not let native rag.search create duplicate rag retrieval fallback tasks', async () => {
    const app = await buildApp();
    setLlmClientForTesting(requestHumanFakeClient({
      toolArguments: {
        query: 'no citation should match this request',
        create_fallback_task: true,
        limit: 99,
      },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: authHeader,
      payload: {
        question: 'No citation should match and only agent fallback should exist',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('manual_review');

    const runId = response.json().data.scoring.run_id as string;
    const toolCalls = await getRows<{ input: Record<string, unknown> }>(
      `
        SELECT input
        FROM agent_tool_calls
        WHERE run_id = $1 AND tool_name = 'rag.search'
      `,
      [runId],
    );
    expect(toolCalls[0].input).toMatchObject({
      limit: 3,
      create_fallback_task: false,
    });

    const fallbackRows = await getRows<{ source_type: string; reason: string }>(
      `
        SELECT source_type, reason
        FROM fallback_tasks
        WHERE run_id = $1
        ORDER BY created_at ASC
      `,
      [runId],
    );
    expect(fallbackRows).toEqual([{
      source_type: 'agent_run',
      reason: 'policy_qa_no_citation',
    }]);
    await app.close();
  });

  it('runs consultation coordinator delegated subagents and verifier fan-in', async () => {
    const app = await buildApp();
    setLlmClientForTesting(consultationDelegateFakeClient());
    const policyId = await createPolicyForRag({
      title: 'Consultation P3 Policy',
      content: 'stable enterprise subsidy furniture revenue conditions are available.',
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyId}/index`,
      headers: authHeader,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: authHeader,
      payload: {
        question: 'Can this furniture company use the stable enterprise subsidy?',
        policy_id: policyId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('answered');

    const runId = response.json().data.scoring.run_id as string;
    const runRows = await getRows<{ state: Record<string, unknown> }>(
      'SELECT state FROM agent_runs WHERE run_id = $1',
      [runId],
    );
    const runtime = runRows[0].state.runtime as Record<string, unknown>;
    expect(runtime.coordinator).toMatchObject({
      agent_type: 'supervisor',
      action: 'delegate_subagent',
      delegated_subagents: ['retrieval_planner', 'policy_analysis'],
      fanout_count: 2,
      fanout_mode: 'sequential',
      fanin_strategy: 'risk_judge_verifier',
      fanin_completed: true,
      permission_scope: {
        entrypoint: 'consultation',
        policy_id: policyId,
        allowed_subagents: ['retrieval_planner', 'policy_analysis', 'risk_judge'],
      },
      budget: {
        max_subagents: 3,
        max_turns_per_subagent: 1,
        verifier_required: true,
      },
    });
    expect(runtime.subagents).toEqual([
      expect.objectContaining({
        agent_type: 'retrieval_planner',
        result_kind: 'raw_task_output',
        status: 'completed',
        runtime: expect.objectContaining({
          parent_run_id: runId,
          task_id: 'retrieval_planner:1',
          checkpoint_id: expect.any(String),
          resume_token: expect.any(String),
        }),
      }),
      expect.objectContaining({
        agent_type: 'policy_analysis',
        result_kind: 'raw_task_output',
        status: 'completed',
        runtime: expect.objectContaining({
          parent_run_id: runId,
          task_id: 'policy_analysis:2',
          checkpoint_id: expect.any(String),
          resume_token: expect.any(String),
        }),
      }),
    ]);
    expect(runtime.subagents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_type: 'risk_judge' }),
    ]));
    expect(runtime.verifier).toMatchObject({
      agent_type: 'risk_judge',
      result_kind: 'final_verifier_result',
      status: 'completed',
      final_judge: {
        approved: true,
        should_fallback: false,
      },
    });

    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}/steps`,
      headers: authHeader,
    });
    expect(steps.json().data.steps.map((step: { node_name: string }) => step.node_name))
      .toEqual([
        'runtime_call_tool',
        'runtime_policy_analysis',
        'runtime_risk_judge',
        'runtime_delegate_subagent',
        'runtime_final',
      ]);
    const nestedCheckpoints = await getRows<{
      status: string;
      state: {
        runtime?: {
          nested_checkpoint?: Record<string, unknown>;
        };
      };
    }>(
      `
        SELECT status, state
        FROM langgraph_checkpoints
        WHERE run_id = $1
          AND status = 'nested_completed'
        ORDER BY created_at ASC
      `,
      [runId],
    );
    expect(nestedCheckpoints).toHaveLength(3);
    expect(nestedCheckpoints.map((row) => row.state.runtime?.nested_checkpoint))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          parent_run_id: runId,
          task_id: 'retrieval_planner:1',
          target_phase: 'consultation',
        }),
        expect.objectContaining({
          parent_run_id: runId,
          task_id: 'policy_analysis:2',
          target_phase: 'consultation',
        }),
        expect.objectContaining({
          parent_run_id: runId,
          task_id: 'risk_judge:verifier',
          target_phase: 'consultation',
        }),
      ]));
    const nestedAudits = await getRows<{ detail: Record<string, unknown> }>(
      `
        SELECT detail
        FROM audit_logs
        WHERE action = 'agent_nested_runtime.checkpointed'
          AND target_id = $1
        ORDER BY created_at ASC
      `,
      [runId],
    );
    expect(nestedAudits).toHaveLength(3);
    expect(nestedAudits[0].detail).toMatchObject({
      parent_run_id: runId,
      target_phase: 'consultation',
      status: 'completed',
    });
    await app.close();
  });

  it('uses the formal runtime fanout_mode switch for parallel delegation', async () => {
    const app = await buildApp();
    setLlmClientForTesting(consultationDelegateFakeClient());
    const policyId = await createPolicyForRag({
      title: 'Consultation Parallel Policy',
      content: 'stable enterprise subsidy furniture revenue conditions are available.',
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyId}/index`,
      headers: authHeader,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: authHeader,
      payload: {
        question: 'Can this furniture company use the stable enterprise subsidy?',
        policy_id: policyId,
        runtime: {
          fanout_mode: 'parallel',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('answered');

    const runId = response.json().data.scoring.run_id as string;
    const runRows = await getRows<{ state: Record<string, unknown> }>(
      'SELECT state FROM agent_runs WHERE run_id = $1',
      [runId],
    );
    const runtime = runRows[0].state.runtime as Record<string, unknown>;
    expect(runtime.coordinator).toMatchObject({
      fanout_mode: 'parallel',
      fanin_strategy: 'risk_judge_verifier',
    });
    expect(runtime.orchestration_contract).toMatchObject({
      version: 'orchestration.v1',
      fanout_mode: 'parallel',
    });
    await app.close();
  });

  it('does not execute risk_judge twice when coordinator includes it in delegated subagents', async () => {
    const app = await buildApp();
    const fakeClient = consultationDelegateExplicitVerifierFakeClient();
    setLlmClientForTesting(fakeClient);
    const policyId = await createPolicyForRag({
      title: 'Consultation Explicit Verifier Policy',
      content: 'stable enterprise subsidy furniture revenue conditions are available.',
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyId}/index`,
      headers: authHeader,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: authHeader,
      payload: {
        question: 'Can this furniture company use the stable enterprise subsidy?',
        policy_id: policyId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('answered');
    expect(fakeClient.getCallCount()).toBe(5);

    const runId = response.json().data.scoring.run_id as string;
    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}/steps`,
      headers: authHeader,
    });
    const stepNames = steps.json().data.steps.map((step: { node_name: string }) => step.node_name);
    expect(stepNames.filter((name: string) => name === 'runtime_risk_judge')).toHaveLength(1);
    expect(stepNames).toEqual([
      'runtime_call_tool',
      'runtime_policy_analysis',
      'runtime_risk_judge',
      'runtime_delegate_subagent',
      'runtime_final',
    ]);

    const runRows = await getRows<{ state: Record<string, unknown> }>(
      'SELECT state FROM agent_runs WHERE run_id = $1',
      [runId],
    );
    const runtime = runRows[0].state.runtime as Record<string, unknown>;
    expect(runtime.coordinator).toMatchObject({
      delegated_subagents: ['retrieval_planner', 'policy_analysis'],
      fanout_count: 2,
      fanin_strategy: 'risk_judge_verifier',
    });
    expect(runtime.verifier).toMatchObject({
      agent_type: 'risk_judge',
      status: 'completed',
    });
    await app.close();
  });

  it('keeps legacy policy QA path when orchestration switch is disabled', async () => {
    process.env.AGENT_ORCHESTRATION_ENABLED = 'false';
    const app = await buildApp();
    const fakeClient = agentFakeClient();
    setLlmClientForTesting(fakeClient);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: authHeader,
      payload: {
        question: 'Legacy path no policy',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.scoring.agent_orchestration_enabled).toBeUndefined();
    expect(fakeClient.getCallCount()).toBe(0);
    await app.close();
  });
});
