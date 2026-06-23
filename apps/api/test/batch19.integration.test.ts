import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FakeLlmClient } from '../src/modules/llm/fake-llm.client.js';
import {
  resetLlmClientForTesting,
  setLlmClientForTesting,
} from '../src/modules/llm/llm-provider.js';
import {
  canConnectDatabase,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';

process.env.ALLOW_DEV_STUB_AUTH = 'true';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;

async function createApplicationFixture() {
  const userRows = await getRows<{ user_id: string }>(
    `
      INSERT INTO users (name, phone, user_type)
      VALUES ('Batch19 Owner', '13919000001', 'enterprise')
      RETURNING user_id::text
    `,
  );
  const actorId = userRows[0].user_id;
  const enterpriseRows = await getRows<{ enterprise_id: string }>(
    `
      INSERT INTO enterprises (name, credit_code, status)
      VALUES ('Batch19 Furniture', '913607FF0000190001', 'active')
      RETURNING enterprise_id::text
    `,
  );
  const enterpriseId = enterpriseRows[0].enterprise_id;
  await getRows(
    `
      INSERT INTO enterprise_accounts (enterprise_id, user_id, role, auth_status)
      VALUES ($1, $2, 'owner', 'manual_approved')
    `,
    [enterpriseId, actorId],
  );
  await getRows(
    `
      INSERT INTO enterprise_profiles (
        enterprise_id,
        enterprise_name,
        credit_code,
        industry,
        revenue_amount,
        employee_count,
        source
      )
      VALUES ($1, 'Batch19 Furniture', '913607FF0000190001', 'furniture', 80, 25, 'manual')
    `,
    [enterpriseId],
  );
  const policyRows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, source_name, source_url, status, version, content)
      VALUES (
        'Batch19 Stable Subsidy',
        'manual_import',
        'Batch19 Source',
        'https://example.test/batch19',
        'effective',
        'v1',
        'Applicant revenue must be at least 100 and OCR credit code must match.'
      )
      RETURNING policy_id::text
    `,
  );
  const policyId = policyRows[0].policy_id;
  await getRows(
    'INSERT INTO policy_ai_whitelist (policy_id, enabled) VALUES ($1, true)',
    [policyId],
  );
  await getRows(
    `
      INSERT INTO policy_conditions (
        policy_id,
        field_key,
        operator,
        target_value,
        required,
        evidence_type,
        fail_action,
        message
      )
      VALUES
        (
          $1,
          'enterprise_profile.revenue_amount',
          'gte',
          '100'::jsonb,
          true,
          'profile',
          'ineligible',
          'Revenue must be at least 100.'
        ),
        (
          $1,
          'ocr.business_license.credit_code',
          'eq',
          '"913607FF0000190001"'::jsonb,
          true,
          'ocr',
          'manual_review',
          'Business license credit code must match.'
        )
    `,
    [policyId],
  );
  const applicationRows = await getRows<{ application_id: string; item_id: string }>(
    `
      WITH app AS (
        INSERT INTO applications (enterprise_id, applicant_user_id, status)
        VALUES ($1, $2, 'submitted')
        RETURNING application_id
      ),
      item AS (
        INSERT INTO application_policy_items (application_id, policy_id, status)
        SELECT application_id, $3, 'submitted'
        FROM app
        RETURNING item_id, application_id
      )
      SELECT application_id::text, item_id::text
      FROM item
    `,
    [enterpriseId, actorId, policyId],
  );
  const applicationId = applicationRows[0].application_id;
  const fileRows = await getRows<{ file_id: string }>(
    `
      INSERT INTO files (
        enterprise_id,
        uploader_user_id,
        original_filename,
        mime_type,
        byte_size,
        file_hash,
        storage_key
      )
      VALUES ($1, $2, 'business-license-low.json', 'application/json', 128, 'batch19hash', 'batch19/storage-key')
      RETURNING file_id::text
    `,
    [enterpriseId, actorId],
  );
  const materialRows = await getRows<{ material_id: string }>(
    `
      INSERT INTO materials (
        application_id,
        material_type,
        file_id,
        file_hash,
        ocr_status
      )
      VALUES ($1, 'business_license', $2, 'batch19hash', 'low_confidence')
      RETURNING material_id::text
    `,
    [applicationId, fileRows[0].file_id],
  );
  const materialId = materialRows[0].material_id;
  await getRows(
    `
      INSERT INTO ocr_results (
        material_id,
        material_type,
        fields,
        field_confidence,
        overall_confidence,
        warnings,
        requires_manual_confirmation
      )
      VALUES (
        $1,
        'business_license',
        '{"credit_code":"913607FF0000190001","enterprise_name":"Batch19 Furniture"}'::jsonb,
        '{"credit_code":0.62,"enterprise_name":0.9}'::jsonb,
        0.62,
        '["credit_code low confidence"]'::jsonb,
        true
      )
    `,
    [materialId],
  );

  return {
    actorId,
    applicationId,
    itemId: applicationRows[0].item_id,
    policyId,
    materialId,
    authHeader: { authorization: `Bearer dev:${actorId}:owner` },
  };
}

function applicationFakeClient() {
  return new FakeLlmClient([
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'ocr.material_evidence.read',
        tool_input: {
          application_id: 'model-must-not-control-scope',
          mode: 'summary',
        },
        rationale: 'Read application materials first.',
      }),
      usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
    },
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'eligibility.rule_engine.check',
        tool_input: {
          application_id: 'model-must-not-control-scope',
          policy_id: 'model-must-not-control-policy',
        },
        rationale: 'Run rule-first eligibility.',
      }),
      usage: { prompt_tokens: 15, completion_tokens: 9, total_tokens: 24 },
    },
    {
      content: JSON.stringify({
        verdict: 'pass',
        explanation: 'LLM math says 80 passes 100, intentionally conflicting with rules.',
        checked_conditions: [{
          field_key: 'enterprise_profile.revenue_amount',
          value: 80,
          target_value: 100,
          operator: 'gte',
        }],
        confidence: 0.77,
      }),
      usage: { prompt_tokens: 15, completion_tokens: 9, total_tokens: 24 },
    },
    {
      content: JSON.stringify({
        approved: true,
        should_fallback: false,
        reasons: [],
        confidence: 0.7,
      }),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

function applicationDelegateFakeClient() {
  return new FakeLlmClient([
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'ocr.material_evidence.read',
        tool_input: {
          mode: 'summary',
        },
      }),
    },
    {
      content: JSON.stringify({
        action: 'delegate_subagent',
        subagents: ['document_vision', 'math_verification'],
        task_input: {
          objective: 'Fan out application evidence checks before final response.',
        },
      }),
    },
    {
      content: JSON.stringify({
        risk_items: [{
          field: 'ocr.low_confidence',
          severity: 'high',
          reason: 'Worker confirms low confidence OCR requires manual review.',
        }],
        usable_as_hard_evidence: false,
        confidence: 0.78,
      }),
    },
    {
      content: JSON.stringify({
        verdict: 'pass',
        explanation: 'Worker math still conflicts with rule-first result.',
        checked_conditions: [],
        confidence: 0.77,
      }),
    },
    {
      content: JSON.stringify({
        approved: true,
        should_fallback: false,
        reasons: [],
        confidence: 0.7,
      }),
    },
    {
      content: JSON.stringify({
        action: 'respond_final',
        answer: 'Application assistant completed after worker fan-in.',
        confidence: 0.86,
      }),
    },
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'eligibility.rule_engine.check',
        tool_input: {},
      }),
    },
    {
      content: JSON.stringify({
        verdict: 'pass',
        explanation: 'LLM math conflicts with rule-first result for regression coverage.',
        checked_conditions: [],
        confidence: 0.76,
      }),
    },
    {
      content: JSON.stringify({
        approved: true,
        should_fallback: false,
        reasons: [],
        confidence: 0.7,
      }),
    },
  ]);
}

describeIfDb('batch19 application multi-agent', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    process.env.AGENT_RUN_ASYNC_ENABLED = 'false';
    await truncateBusinessTables();
  });

  afterEach(() => {
    resetLlmClientForTesting();
  });

  it('keeps low-confidence OCR out of hard evidence and lets rules override LLM conflicts', async () => {
    const app = await buildApp();
    const fakeClient = applicationFakeClient();
    setLlmClientForTesting(fakeClient);
    const fixture = await createApplicationFixture();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: fixture.authHeader,
      payload: {
        entrypoint: 'application',
        input: {
          application_id: fixture.applicationId,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('interrupted');
    expect(response.json().data.current_node).toBe('human_fallback');
    expect(response.json().data.state.ocr.materials[0]).toMatchObject({
      material_id: fixture.materialId,
      ocr_status: 'low_confidence',
      hard_evidence_allowed: false,
      requires_manual_confirmation: true,
    });
    expect(response.json().data.state.document_vision.risk_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'ocr.low_confidence',
          severity: 'high',
        }),
      ]),
    );
    expect(response.json().data.state.document_vision.usable_as_hard_evidence).toBe(false);
    expect(response.json().data.state.eligibility).toMatchObject({
      result: 'ineligible',
      rule_first: true,
    });
    expect(response.json().data.state.math_verification).toMatchObject({
      verdict: 'pass',
      explanation: expect.stringContaining('conflicting with rules'),
    });
    expect(response.json().data.state.judge).toMatchObject({
      approved: false,
      should_fallback: true,
      reasons: expect.arrayContaining([
        'low_confidence_ocr_requires_manual_confirmation',
        'rule_engine_overrides_llm_conflict',
      ]),
    });
    expect(fakeClient.getCallCount()).toBe(4);

    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${response.json().data.run_id}/steps`,
      headers: fixture.authHeader,
    });
    const stepNames = steps.json().data.steps.map((step: { node_name: string }) => step.node_name);
    expect(stepNames).toEqual([
      'runtime_call_tool',
      'runtime_call_tool',
      'runtime_math_verification',
      'runtime_risk_judge',
      'runtime_request_human',
    ]);
    const runtimeToolSteps = steps.json().data.steps.filter(
      (step: { node_name: string }) => step.node_name === 'runtime_call_tool',
    );
    expect(runtimeToolSteps).toHaveLength(2);
    expect(runtimeToolSteps.every((step: { input: { action?: string } }) => step.input.action === 'call_tool'))
      .toBe(true);
    expect(steps.json().data.tool_calls.map((call: { tool_name: string }) => call.tool_name))
      .toEqual(['ocr.material_evidence.read', 'eligibility.rule_engine.check']);
    expect(steps.json().data.tool_calls[0].input).toMatchObject({
      application_id: fixture.applicationId,
      mode: 'full',
      agent_type: 'document_vision',
      entrypoint: 'application',
    });
    expect(steps.json().data.tool_calls[1].input).toMatchObject({
      application_id: fixture.applicationId,
      policy_id: fixture.policyId,
      agent_type: 'application_assist',
      entrypoint: 'application',
    });

    const fallbackRows = await getRows<{ run_id: string; reason: string }>(
      'SELECT run_id, reason FROM fallback_tasks WHERE run_id = $1',
      [response.json().data.run_id],
    );
    expect(fallbackRows).toEqual([{
      run_id: response.json().data.run_id,
      reason: 'application_agent_risk_fallback',
    }]);
    await app.close();
  });

  it('does not allow application runtime to finish before required artifacts exist', async () => {
    const app = await buildApp();
    setLlmClientForTesting(new FakeLlmClient([
      {
        content: JSON.stringify({
          action: 'respond_final',
          answer: 'finish without checks',
          confidence: 0.9,
        }),
      },
    ]));
    const fixture = await createApplicationFixture();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: fixture.authHeader,
      payload: {
        entrypoint: 'application',
        input: {
          application_id: fixture.applicationId,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('interrupted');
    expect(response.json().data.state.fallback.reason)
      .toBe('application_runtime_missing_required_artifacts');
    expect(response.json().data.state.final.status).toBe('manual_review');
    await app.close();
  });

  it('runs application coordinator delegated subagents and verifier fan-in before final gate', async () => {
    const app = await buildApp();
    setLlmClientForTesting(applicationDelegateFakeClient());
    const fixture = await createApplicationFixture();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: fixture.authHeader,
      payload: {
        entrypoint: 'application',
        input: {
          application_id: fixture.applicationId,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('interrupted');
    expect(response.json().data.current_node).toBe('human_fallback');
    expect(response.json().data.state.runtime.coordinator).toMatchObject({
      agent_type: 'application_assist',
      action: 'delegate_subagent',
      delegated_subagents: ['document_vision', 'math_verification'],
      fanout_count: 2,
      fanout_mode: 'sequential',
      fanin_strategy: 'risk_judge_verifier',
      fanin_completed: true,
      permission_scope: {
        entrypoint: 'application',
        item_id: fixture.itemId,
        application_id: fixture.applicationId,
        policy_id: fixture.policyId,
        allowed_subagents: ['document_vision', 'math_verification', 'risk_judge'],
      },
      budget: {
        max_subagents: 3,
        max_turns_per_subagent: 1,
        verifier_required: true,
      },
    });
    expect(response.json().data.state.runtime.subagents).toEqual([
      expect.objectContaining({
        agent_type: 'document_vision',
        status: 'completed',
        permission_scope: expect.objectContaining({
          entrypoint: 'application',
          application_id: fixture.applicationId,
        }),
      }),
      expect.objectContaining({
        agent_type: 'math_verification',
        status: 'completed',
        permission_scope: expect.objectContaining({
          entrypoint: 'application',
          application_id: fixture.applicationId,
        }),
      }),
    ]);
    expect(response.json().data.state.runtime.subagents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_type: 'risk_judge' }),
    ]));
    expect(response.json().data.state.runtime.verifier).toMatchObject({
      agent_type: 'risk_judge',
      result_kind: 'final_verifier_result',
      status: 'completed',
      budget: {
        max_turns: 1,
        required: true,
      },
    });
    expect(response.json().data.state.judge).toMatchObject({
      approved: true,
      should_fallback: false,
      reasons: expect.arrayContaining([
        'low_confidence_ocr_requires_manual_confirmation',
      ]),
    });
    expect(response.json().data.state.fallback.reason)
      .toBe('application_runtime_missing_required_artifacts');

    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${response.json().data.run_id}/steps`,
      headers: fixture.authHeader,
    });
    expect(steps.json().data.steps.map((step: { node_name: string }) => step.node_name))
      .toEqual([
        'runtime_call_tool',
        'runtime_document_vision',
        'runtime_math_verification',
        'runtime_risk_judge',
        'runtime_delegate_subagent',
        'runtime_request_human',
      ]);
    await app.close();
  });
});
