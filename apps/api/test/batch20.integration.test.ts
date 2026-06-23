import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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

async function createReviewFixture() {
  const ownerRows = await getRows<{ user_id: string }>(
    `
      INSERT INTO users (name, phone, user_type)
      VALUES ('Batch20 Owner', '13920000001', 'enterprise')
      RETURNING user_id::text
    `,
  );
  const reviewerRows = await getRows<{ user_id: string }>(
    `
      INSERT INTO users (name, phone, user_type)
      VALUES ('Batch20 Reviewer', '13920000002', 'government')
      RETURNING user_id::text
    `,
  );
  const ownerId = ownerRows[0].user_id;
  const reviewerId = reviewerRows[0].user_id;
  const enterpriseRows = await getRows<{ enterprise_id: string }>(
    `
      INSERT INTO enterprises (name, credit_code, status)
      VALUES ('Batch20 Furniture', '913607FF0000200001', 'active')
      RETURNING enterprise_id::text
    `,
  );
  const enterpriseId = enterpriseRows[0].enterprise_id;
  await getRows(
    `
      INSERT INTO enterprise_accounts (enterprise_id, user_id, role, auth_status)
      VALUES ($1, $2, 'owner', 'manual_approved')
    `,
    [enterpriseId, ownerId],
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
      VALUES ($1, 'Batch20 Furniture', '913607FF0000200001', 'furniture', 120, 32, 'manual')
    `,
    [enterpriseId],
  );
  const policyRows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, source_name, source_url, status, version, content)
      VALUES (
        'Batch20 Review Policy',
        'manual_import',
        'Batch20 Source',
        'https://example.test/batch20',
        'effective',
        'v1',
        'Revenue must be at least 100 and business license evidence must be usable.'
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
          '"913607FF0000200001"'::jsonb,
          true,
          'ocr',
          'manual_review',
          'Business license credit code must be confirmed.'
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
    [enterpriseId, ownerId, policyId],
  );
  const applicationId = applicationRows[0].application_id;
  const itemId = applicationRows[0].item_id;
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
      VALUES ($1, $2, 'batch20-license.json', 'application/json', 128, 'batch20hash', 'batch20/storage-key')
      RETURNING file_id::text
    `,
    [enterpriseId, ownerId],
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
      VALUES ($1, 'business_license', $2, 'batch20hash', 'low_confidence')
      RETURNING material_id::text
    `,
    [applicationId, fileRows[0].file_id],
  );
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
        '{"credit_code":"913607FF0000200001","enterprise_name":"Batch20 Furniture"}'::jsonb,
        '{"credit_code":0.64,"enterprise_name":0.91}'::jsonb,
        0.64,
        '["credit_code needs manual review"]'::jsonb,
        true
      )
    `,
    [materialRows[0].material_id],
  );

  return {
    reviewerId,
    itemId,
    applicationId,
    authHeader: { authorization: `Bearer dev:${reviewerId}:reviewer` },
  };
}

function reviewFakeClient() {
  return new FakeLlmClient([
    {
      content: JSON.stringify({
        action: 'update_plan',
        plan_update: 'Check OCR confidence and revenue threshold.',
        open_tasks: ['Read material summaries', 'Run eligibility rules'],
        completed_tasks: [],
      }),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'ocr.material_evidence.read',
        tool_input: {
          application_id: 'model-must-not-control-scope',
          mode: 'full',
        },
        rationale: 'Read review material summaries.',
      }),
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    },
    {
      content: JSON.stringify({
        risk_items: [{
          field: 'business_license.summary',
          severity: 'medium',
          reason: 'Business license summary indicates OCR confirmation is needed.',
        }],
        usable_as_hard_evidence: false,
        confidence: 0.82,
      }),
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
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
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    },
    {
      content: JSON.stringify({
        verdict: 'pass',
        explanation: 'Revenue 120 is greater than the 100 threshold.',
        checked_conditions: [{
          field_key: 'enterprise_profile.revenue_amount',
          value: 120,
          target_value: 100,
          operator: 'gte',
        }],
        confidence: 0.9,
      }),
      usage: { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22 },
    },
    {
      content: JSON.stringify({
        approved: false,
        should_fallback: false,
        reasons: ['manual reviewer must decide'],
        confidence: 0.8,
      }),
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    },
    {
      content: JSON.stringify({
        action: 'respond_final',
        answer: 'AI draft only; human reviewer must decide. Please confirm business license credit code manually.',
        confidence: 0.84,
      }),
      usage: { prompt_tokens: 16, completion_tokens: 10, total_tokens: 26 },
    },
  ]);
}

function reviewDelegateFakeClient() {
  return new FakeLlmClient([
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'ocr.material_evidence.read',
        tool_input: {
          mode: 'full',
        },
      }),
    },
    {
      content: JSON.stringify({
        risk_items: [{
          field: 'business_license.auto_summary',
          severity: 'medium',
          reason: 'Automatic document vision pass found summary review risk.',
        }],
        usable_as_hard_evidence: false,
        confidence: 0.8,
      }),
    },
    {
      content: JSON.stringify({
        action: 'delegate_subagent',
        subagents: ['document_vision', 'math_verification'],
        task_input: {
          objective: 'Review material summary and numeric rule evidence.',
        },
        rationale: 'Fan out to specialist review workers before drafting.',
      }),
    },
    {
      content: JSON.stringify({
        risk_items: [{
          field: 'business_license.summary',
          severity: 'medium',
          reason: 'Document summary should be manually checked.',
        }],
        usable_as_hard_evidence: false,
        confidence: 0.81,
      }),
    },
    {
      content: JSON.stringify({
        verdict: 'unknown',
        explanation: 'Eligibility has not been run yet; numeric verification is advisory only.',
        checked_conditions: [],
        confidence: 0.62,
      }),
    },
    {
      content: JSON.stringify({
        approved: false,
        should_fallback: true,
        reasons: ['verifier requires human review after subagent fan-in'],
        confidence: 0.78,
      }),
    },
    {
      content: JSON.stringify({
        action: 'respond_final',
        answer: 'Coordinator draft after worker fan-in; human reviewer must decide.',
        confidence: 0.8,
      }),
    },
  ]);
}

describeIfDb('batch20 review multi-agent draft', () => {
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

  it('generates review draft, shows it in detail, and lets reviewer adopt revise or ignore without auto decision', async () => {
    const app = await buildApp();
    const fakeClient = reviewFakeClient();
    setLlmClientForTesting(fakeClient);
    const fixture = await createReviewFixture();

    const run = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: fixture.authHeader,
      payload: {
        entrypoint: 'review',
        input: {
          item_id: fixture.itemId,
        },
      },
    });

    expect(run.statusCode).toBe(200);
    expect(run.json().data.status).toBe('completed');
    expect(run.json().data.current_node).toBe('runtime_review_draft');
    expect(run.json().data.state.review_draft).toMatchObject({
      suggested_decision: 'request_supplement',
      no_auto_decision: true,
      opinion: 'AI draft only; human reviewer must decide. Please confirm business license credit code manually.',
    });
    expect(run.json().data.state.ocr.materials[0].fields).toEqual({});
    expect(run.json().data.state.final).toMatchObject({
      status: 'draft_generated',
      next_actions: ['human_reviewer_adopt_revise_or_ignore'],
    });
    expect(fakeClient.getCallCount()).toBe(7);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/review/tasks/${fixture.itemId}`,
      headers: fixture.authHeader,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.agent_assist_disclaimer).toContain('最终审核结论以人工审核为准');
    expect(detail.json().data.agent_drafts).toHaveLength(1);
    const draft = detail.json().data.agent_drafts[0];
    expect(draft).toMatchObject({
      run_id: run.json().data.run_id,
      item_id: fixture.itemId,
      application_id: fixture.applicationId,
      status: 'generated',
      suggested_decision: 'request_supplement',
      opinion: 'AI draft only; human reviewer must decide. Please confirm business license credit code manually.',
    });
    expect(draft.responsibility_boundary).toMatchObject({
      notice: expect.any(String),
      no_auto_approval: true,
      adoption_is_not_decision: true,
      run_id: run.json().data.run_id,
    });
    expect(draft.risk_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'ocr.low_confidence',
          severity: 'high',
        }),
      ]),
    );
    expect(draft.missing_evidence).toEqual([
      'ocr.business_license.credit_code',
    ]);
    expect(draft.agent_outputs).toMatchObject({
      runtime: expect.any(Object),
      document_vision: expect.any(Object),
      eligibility: expect.any(Object),
      math_verification: expect.any(Object),
      risk_judge: expect.any(Object),
    });
    expect(draft.agent_outputs.review_agent).toBeUndefined();

    const adopt = await app.inject({
      method: 'POST',
      url: `/api/v1/review/agent-drafts/${draft.draft_id}/handle`,
      headers: fixture.authHeader,
      payload: {
        action: 'adopt',
        comment: 'Adopt draft as human review reference.',
      },
    });
    expect(adopt.statusCode).toBe(200);
    expect(adopt.json().data.status).toBe('adopted');

    const reviseRows = await getRows<{ draft_id: string }>(
      `
        INSERT INTO review_agent_drafts (
          run_id,
          item_id,
          application_id,
          reviewer_id,
          suggested_decision,
          opinion,
          risk_items,
          missing_evidence,
          reasoning,
          agent_outputs
        )
        VALUES ($1, $2, $3, $4, 'manual_review', 'draft to revise', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
        RETURNING draft_id::text
      `,
      [run.json().data.run_id, fixture.itemId, fixture.applicationId, fixture.reviewerId],
    );
    const revise = await app.inject({
      method: 'POST',
      url: `/api/v1/review/agent-drafts/${reviseRows[0].draft_id}/handle`,
      headers: fixture.authHeader,
      payload: {
        action: 'revise',
        revised_opinion: '人工修改后的审核意见草稿',
        comment: '调整措辞',
      },
    });
    expect(revise.statusCode).toBe(200);
    expect(revise.json().data.status).toBe('revised');
    expect(revise.json().data.revised_opinion).toBe('人工修改后的审核意见草稿');

    const ignoreRows = await getRows<{ draft_id: string }>(
      `
        INSERT INTO review_agent_drafts (
          run_id,
          item_id,
          application_id,
          reviewer_id,
          suggested_decision,
          opinion,
          risk_items,
          missing_evidence,
          reasoning,
          agent_outputs
        )
        VALUES ($1, $2, $3, $4, 'manual_review', 'draft to ignore', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
        RETURNING draft_id::text
      `,
      [run.json().data.run_id, fixture.itemId, fixture.applicationId, fixture.reviewerId],
    );
    const ignore = await app.inject({
      method: 'POST',
      url: `/api/v1/review/agent-drafts/${ignoreRows[0].draft_id}/handle`,
      headers: fixture.authHeader,
      payload: {
        action: 'ignore',
        comment: '不采用该建议',
      },
    });
    expect(ignore.statusCode).toBe(200);
    expect(ignore.json().data.status).toBe('ignored');

    const unchanged = await getRows<{
      application_status: string;
      policy_item_status: string;
      review_result: string | null;
    }>(
      `
        SELECT
          a.status::text AS application_status,
          api.status::text AS policy_item_status,
          api.review_result
        FROM application_policy_items api
        INNER JOIN applications a ON a.application_id = api.application_id
        WHERE api.item_id = $1
      `,
      [fixture.itemId],
    );
    expect(unchanged[0]).toEqual({
      application_status: 'submitted',
      policy_item_status: 'submitted',
      review_result: null,
    });

    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${run.json().data.run_id}/steps`,
      headers: fixture.authHeader,
    });
    expect(steps.json().data.steps.map((step: { node_name: string }) => step.node_name))
      .toEqual([
        'runtime_update_plan',
        'runtime_call_tool',
        'runtime_document_vision',
        'runtime_call_tool',
        'runtime_math_verification',
        'runtime_risk_judge',
        'runtime_review_draft',
      ]);
    expect(steps.json().data.tool_calls.map((call: { tool_name: string }) => call.tool_name))
      .toEqual([
        'ocr.material_evidence.read',
        'eligibility.rule_engine.check',
      ]);
    expect(steps.json().data.tool_calls[0].input).toMatchObject({
      application_id: fixture.applicationId,
      mode: 'summary',
      agent_type: 'document_vision',
      entrypoint: 'review',
      item_id: fixture.itemId,
    });

    const audits = await getRows<{ action: string; detail: Record<string, unknown> }>(
      `
        SELECT action, detail
        FROM audit_logs
        WHERE action LIKE 'review.agent_draft.%'
        ORDER BY created_at ASC
      `,
    );
    expect(audits.map((row) => row.action)).toEqual([
      'review.agent_draft.generate',
      'review.agent_draft.adopt',
      'review.agent_draft.revise',
      'review.agent_draft.ignore',
    ]);
    expect(audits[0].detail.no_auto_decision).toBe(true);
    expect(audits[1].detail.no_auto_decision).toBe(
      'Batch 20 draft handling does not call review.decide or mutate application status.',
    );
    await app.close();
  });

  it('resumes review runs through the same runtime loop instead of the legacy fixed chain', async () => {
    const app = await buildApp();
    setLlmClientForTesting(reviewFakeClient());
    const fixture = await createReviewFixture();
    const runId = randomUUID();
    const traceId = randomUUID();
    const initialState = {
      run_id: runId,
      trace_id: traceId,
      actor_id: fixture.reviewerId,
      entrypoint: 'review',
      input: {
        item_id: fixture.itemId,
      },
      current_node: 'human_fallback',
      fallback: {
        task_id: '',
        reason: 'review_runtime_needs_manual_context',
      },
      runtime: {
        actor: {
          roles: ['reviewer'],
          user_type: 'government',
        },
      },
      errors: [],
    };
    await getRows(
      `
        INSERT INTO agent_runs (
          run_id,
          actor_id,
          entrypoint,
          trace_id,
          state,
          status,
          current_node
        )
        VALUES ($1, $2, 'review', $3, $4::jsonb, 'interrupted', 'human_fallback')
      `,
      [runId, fixture.reviewerId, traceId, JSON.stringify(initialState)],
    );
    const taskRows = await getRows<{ task_id: string }>(
      `
        INSERT INTO fallback_tasks (
          run_id,
          source_type,
          source_id,
          reason,
          status,
          resolved_payload,
          resolution_type,
          resolved_by,
          resolved_at
        )
        VALUES (
          $1,
          'agent_run',
          $1,
          'review_runtime_needs_manual_context',
          'resolved',
          '{"confirmed_materials":[]}'::jsonb,
          'field_patch',
          $2,
          now()
        )
        RETURNING task_id::text
      `,
      [runId, fixture.reviewerId],
    );
    const taskId = taskRows[0].task_id;
    const stateWithTask = {
      ...initialState,
      fallback: {
        ...initialState.fallback,
        task_id: taskId,
      },
    };
    await getRows(
      `
        UPDATE agent_runs
        SET state = $2::jsonb
        WHERE run_id = $1
      `,
      [runId, JSON.stringify(stateWithTask)],
    );
    await getRows(
      `
        INSERT INTO langgraph_checkpoints (run_id, state, status)
        VALUES ($1, $2::jsonb, 'interrupted')
      `,
      [runId, JSON.stringify(stateWithTask)],
    );

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: fixture.authHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'batch20-review-runtime-resume',
        resume_payload: {
          confirmed_materials: [],
        },
      },
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().data.status).toBe('completed');
    expect(resumed.json().data.current_node).toBe('runtime_review_draft');
    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}/steps`,
      headers: fixture.authHeader,
    });
    const stepNames = steps.json().data.steps.map((step: { node_name: string }) => step.node_name);
    expect(stepNames).toContain('human_fallback_resume');
    expect(stepNames).toContain('runtime_document_vision');
    expect(stepNames).toContain('runtime_review_draft');
    expect(stepNames).not.toContain('draft_review_opinion');
    await app.close();
  });

  it('persists stop_run cancelled as cancelled instead of failed', async () => {
    const app = await buildApp();
    setLlmClientForTesting(new FakeLlmClient([{
      content: JSON.stringify({
        action: 'stop_run',
        reason: 'reviewer cancelled draft generation',
        status: 'cancelled',
      }),
    }]));
    const fixture = await createReviewFixture();

    const cancelled = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: fixture.authHeader,
      payload: {
        entrypoint: 'review',
        input: {
          item_id: fixture.itemId,
        },
      },
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data.status).toBe('cancelled');
    expect(cancelled.json().data.current_node).toBe('stopped');

    const rows = await getRows<{ status: string }>(
      `
        SELECT status::text
        FROM langgraph_checkpoints
        WHERE run_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [cancelled.json().data.run_id],
    );
    expect(rows[0].status).toBe('cancelled');

    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${cancelled.json().data.run_id}/steps`,
      headers: fixture.authHeader,
    });
    expect(steps.json().data.steps[0]).toMatchObject({
      node_name: 'runtime_stop',
      status: 'completed',
    });
    await app.close();
  });

  it('runs coordinator delegated subagents and verifier fan-in before drafting', async () => {
    const app = await buildApp();
    setLlmClientForTesting(reviewDelegateFakeClient());
    const fixture = await createReviewFixture();

    const run = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: fixture.authHeader,
      payload: {
        entrypoint: 'review',
        input: {
          item_id: fixture.itemId,
        },
      },
    });

    expect(run.statusCode).toBe(200);
    expect(run.json().data.status).toBe('completed');
    expect(run.json().data.current_node).toBe('runtime_review_draft');
    expect(run.json().data.state.runtime.coordinator).toMatchObject({
      agent_type: 'review',
      action: 'delegate_subagent',
      delegated_subagents: ['document_vision', 'math_verification'],
      fanout_count: 2,
      fanout_mode: 'sequential',
      fanin_strategy: 'risk_judge_verifier',
      fanin_completed: true,
      permission_scope: {
        entrypoint: 'review',
        item_id: fixture.itemId,
        application_id: fixture.applicationId,
        allowed_subagents: ['document_vision', 'math_verification', 'risk_judge'],
      },
      budget: {
        max_subagents: 3,
        max_turns_per_subagent: 1,
        verifier_required: true,
      },
    });
    expect(run.json().data.state.runtime.subagents).toEqual([
      expect.objectContaining({
        agent_type: 'document_vision',
        status: 'completed',
        permission_scope: expect.objectContaining({
          entrypoint: 'review',
          item_id: fixture.itemId,
          application_id: fixture.applicationId,
        }),
        budget: {
          max_turns: 1,
          max_tool_calls: 0,
        },
      }),
      expect.objectContaining({
        agent_type: 'math_verification',
        status: 'completed',
        permission_scope: expect.objectContaining({
          entrypoint: 'review',
          item_id: fixture.itemId,
          application_id: fixture.applicationId,
        }),
        budget: {
          max_turns: 1,
          max_tool_calls: 0,
        },
      }),
    ]);
    expect(run.json().data.state.runtime.subagents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_type: 'risk_judge' }),
    ]));
    expect(run.json().data.state.runtime.verifier).toMatchObject({
      agent_type: 'risk_judge',
      result_kind: 'final_verifier_result',
      status: 'completed',
      permission_scope: {
        entrypoint: 'review',
        item_id: fixture.itemId,
        application_id: fixture.applicationId,
      },
      budget: {
        max_turns: 1,
        required: true,
      },
    });
    expect(run.json().data.state.judge).toMatchObject({
      approved: false,
      should_fallback: true,
    });
    expect(run.json().data.state.ocr.materials[0].fields).toEqual({});

    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${run.json().data.run_id}/steps`,
      headers: fixture.authHeader,
    });
    expect(steps.json().data.steps.map((step: { node_name: string }) => step.node_name))
      .toEqual([
        'runtime_call_tool',
        'runtime_document_vision',
        'runtime_document_vision',
        'runtime_math_verification',
        'runtime_risk_judge',
        'runtime_delegate_subagent',
        'runtime_review_draft',
      ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/review/tasks/${fixture.itemId}`,
      headers: fixture.authHeader,
    });
    const draft = detail.json().data.agent_drafts[0];
    expect(draft.agent_outputs).toMatchObject({
      coordinator: expect.objectContaining({
        fanin_completed: true,
        permission_scope: expect.objectContaining({
          item_id: fixture.itemId,
          application_id: fixture.applicationId,
        }),
        budget: expect.objectContaining({
          max_subagents: 3,
          verifier_required: true,
        }),
      }),
      verifier: expect.objectContaining({
        agent_type: 'risk_judge',
        budget: expect.objectContaining({
          required: true,
        }),
      }),
    });
    expect(draft.agent_outputs.subagents).toHaveLength(2);
    await app.close();
  });
});
