import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FakeLlmClient } from '../src/modules/llm/fake-llm.client.js';
import {
  LlmError,
  type LlmChatRequest,
  type LlmChatResponse,
} from '../src/modules/llm/llm.types.js';
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

type ApplicationFixture = {
  ownerId: string;
  otherOwnerId: string;
  reviewerId: string;
  readOnlyReviewerId: string;
  enterpriseId: string;
  applicationId: string;
  itemId: string;
  policyId: string;
  secondItemId?: string;
  secondPolicyId?: string;
  ownerHeader: { authorization: string };
  otherOwnerHeader: { authorization: string };
  reviewerHeader: { authorization: string };
  readOnlyReviewerHeader: { authorization: string };
};

async function createApplicationFixture(input: {
  multiPolicy?: boolean;
  revenue?: number;
  revenueFailAction?: 'ineligible' | 'manual_review';
} = {}): Promise<ApplicationFixture> {
  const ownerRows = await getRows<{ user_id: string }>(
    `
      INSERT INTO users (name, phone, user_type)
      VALUES
        ('Batch21 Owner', '13921000001', 'enterprise'),
        ('Batch21 Other Owner', '13921000002', 'enterprise'),
        ('Batch21 Reviewer', '13921000003', 'government'),
        ('Batch21 Read Only Reviewer', '13921000004', 'government')
      RETURNING user_id::text
    `,
  );
  const ownerId = ownerRows[0].user_id;
  const otherOwnerId = ownerRows[1].user_id;
  const reviewerId = ownerRows[2].user_id;
  const readOnlyReviewerId = ownerRows[3].user_id;

  const enterpriseRows = await getRows<{ enterprise_id: string }>(
    `
      INSERT INTO enterprises (name, credit_code, status)
      VALUES
        ('Batch21 Owned Enterprise', '913607FF0000210001', 'active'),
        ('Batch21 Other Enterprise', '913607FF0000210002', 'active')
      RETURNING enterprise_id::text
    `,
  );
  const enterpriseId = enterpriseRows[0].enterprise_id;
  const otherEnterpriseId = enterpriseRows[1].enterprise_id;

  await getRows(
    `
      INSERT INTO enterprise_accounts (enterprise_id, user_id, role, auth_status)
      VALUES
        ($1, $2, 'owner', 'manual_approved'),
        ($3, $4, 'owner', 'manual_approved')
    `,
    [enterpriseId, ownerId, otherEnterpriseId, otherOwnerId],
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
      VALUES ($1, 'Batch21 Owned Enterprise', '913607FF0000210001', 'furniture', $2, 40, 'manual')
    `,
    [enterpriseId, input.revenue ?? 150],
  );

  const policyRows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, source_name, source_url, status, version, content)
      VALUES
        ('Batch21 Main Policy', 'manual_import', 'Batch21 Source', 'https://example.test/batch21-main', 'effective', 'v1', 'Revenue must be at least 100.'),
        ('Batch21 Second Policy', 'manual_import', 'Batch21 Source', 'https://example.test/batch21-second', 'effective', 'v1', 'Revenue must be at least 100.')
      RETURNING policy_id::text
    `,
  );
  const policyId = policyRows[0].policy_id;
  const secondPolicyId = policyRows[1].policy_id;
  await getRows(
    `
      INSERT INTO policy_ai_whitelist (policy_id, enabled)
      VALUES ($1, true), ($2, true)
    `,
    [policyId, secondPolicyId],
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
        ($1, 'enterprise_profile.revenue_amount', 'gte', '100'::jsonb, true, 'profile', $3, 'Revenue must be at least 100.'),
        ($2, 'enterprise_profile.revenue_amount', 'gte', '100'::jsonb, true, 'profile', $3, 'Revenue must be at least 100.')
    `,
    [policyId, secondPolicyId, input.revenueFailAction ?? 'ineligible'],
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

  let secondItemId: string | undefined;
  if (input.multiPolicy) {
    const secondItemRows = await getRows<{ item_id: string }>(
      `
        INSERT INTO application_policy_items (application_id, policy_id, status)
        VALUES ($1, $2, 'submitted')
        RETURNING item_id::text
      `,
      [applicationId, secondPolicyId],
    );
    secondItemId = secondItemRows[0].item_id;
  }

  return {
    ownerId,
    otherOwnerId,
    reviewerId,
    readOnlyReviewerId,
    enterpriseId,
    applicationId,
    itemId,
    policyId,
    secondItemId,
    secondPolicyId: input.multiPolicy ? secondPolicyId : undefined,
    ownerHeader: { authorization: `Bearer dev:${ownerId}:owner` },
    otherOwnerHeader: { authorization: `Bearer dev:${otherOwnerId}:owner` },
    reviewerHeader: { authorization: `Bearer dev:${reviewerId}:reviewer` },
    readOnlyReviewerHeader: { authorization: `Bearer dev:${readOnlyReviewerId}:window_staff` },
  };
}

async function createAdditionalApplicationForOwner(input: {
  enterprise_id: string;
  owner_id: string;
  policy_id: string;
}): Promise<{ applicationId: string; itemId: string }> {
  const rows = await getRows<{ application_id: string; item_id: string }>(
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
    [input.enterprise_id, input.owner_id, input.policy_id],
  );
  return {
    applicationId: rows[0].application_id,
    itemId: rows[0].item_id,
  };
}

function successfulApplicationClient() {
  return new FakeLlmClient([
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'ocr.material_evidence.read',
        tool_input: {},
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
        explanation: 'Revenue 150 is greater than 100.',
        checked_conditions: [],
        confidence: 0.91,
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
        answer: 'Application agent run completed. Eligibility remains rule-engine first.',
        confidence: 0.82,
      }),
    },
  ]);
}

function manualReviewApplicationClient() {
  return new FakeLlmClient([
    {
      content: JSON.stringify({
        action: 'call_tool',
        tool_name: 'ocr.material_evidence.read',
        tool_input: {},
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
        verdict: 'fail',
        explanation: 'Revenue does not satisfy the threshold.',
        checked_conditions: [],
        confidence: 0.91,
      }),
    },
    {
      content: JSON.stringify({
        approved: false,
        should_fallback: true,
        reasons: ['rule_engine_requires_manual_review'],
        confidence: 0.82,
      }),
    },
  ]);
}

class ConfigurationErrorLlmClient extends FakeLlmClient {
  override async chatCompletion<TJson = unknown>(
    request: LlmChatRequest,
  ): Promise<LlmChatResponse<TJson>> {
    throw new LlmError({
      type: 'configuration',
      message: 'BAILIAN_API_KEY is not configured',
      retryable: false,
      provider: 'fake',
      model: request.model,
      trace_id: request.trace_id,
    });
  }
}

describeIfDb('batch21 agent production hardening', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    process.env.ALLOW_DEV_STUB_AUTH = 'true';
    process.env.AGENT_RUN_ASYNC_ENABLED = 'false';
    process.env.NODE_ENV = 'test';
    await truncateBusinessTables();
  });

  afterEach(() => {
    process.env.NODE_ENV = 'test';
    resetLlmClientForTesting();
  });

  it('blocks mock entrypoints in production', async () => {
    process.env.NODE_ENV = 'production';
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: { authorization: 'Bearer dev:batch21-admin:system_admin' },
      payload: {
        entrypoint: 'mock_completed',
        input: { message: 'must not run in production' },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe('mock agent run entrypoints are disabled');
    await app.close();
  });

  it('enforces application ownership on start and read', async () => {
    const app = await buildApp();
    setLlmClientForTesting(successfulApplicationClient());
    const fixture = await createApplicationFixture();

    const deniedStart = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${fixture.applicationId}/agent-assist`,
      headers: fixture.otherOwnerHeader,
      payload: {},
    });
    expect(deniedStart.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${fixture.applicationId}/agent-assist`,
      headers: fixture.ownerHeader,
      payload: {
        idempotency_key: 'batch21-owned-application',
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.status).toBe('completed');

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${fixture.applicationId}/agent-assist`,
      headers: fixture.ownerHeader,
      payload: {
        idempotency_key: 'batch21-owned-application',
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().data.run_id).toBe(created.json().data.run_id);

    const deniedRead = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${created.json().data.run_id}`,
      headers: fixture.otherOwnerHeader,
    });
    expect(deniedRead.statusCode).toBe(403);
    await app.close();
  });

  it('exposes official review draft endpoint without allowing enterprise users', async () => {
    const app = await buildApp();
    setLlmClientForTesting(new FakeLlmClient([
      {
        content: JSON.stringify({
          action: 'call_tool',
          tool_name: 'ocr.material_evidence.read',
          tool_input: {},
        }),
      },
      {
        content: JSON.stringify({
          risk_items: [],
          usable_as_hard_evidence: true,
          confidence: 0.8,
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
          explanation: 'Revenue passes.',
          checked_conditions: [],
          confidence: 0.9,
        }),
      },
      {
        content: JSON.stringify({
          approved: false,
          should_fallback: false,
          reasons: ['human reviewer decides'],
          confidence: 0.8,
        }),
      },
      {
        content: JSON.stringify({
          action: 'respond_final',
          answer: 'AI draft only; human reviewer must decide.',
          confidence: 0.8,
        }),
      },
    ]));
    const fixture = await createApplicationFixture();

    const enterpriseDenied = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${fixture.itemId}/agent-draft`,
      headers: fixture.ownerHeader,
      payload: {},
    });
    expect(enterpriseDenied.statusCode).toBe(403);

    const draft = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${fixture.itemId}/agent-draft`,
      headers: fixture.reviewerHeader,
      payload: {
        idempotency_key: 'batch21-review-draft',
      },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().data.status).toBe('completed');
    expect(draft.json().data.state.review_draft.no_auto_decision).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/review/tasks/${fixture.itemId}`,
      headers: fixture.reviewerHeader,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.agent_drafts[0]).toMatchObject({
      run_id: draft.json().data.run_id,
      status: 'generated',
    });
    await app.close();
  });

  it('does not let read-only reviewers bypass draft generation permission through generic agent runs', async () => {
    const app = await buildApp();
    setLlmClientForTesting(new FakeLlmClient([
      { content: '{"review_focus":[],"evidence_questions":[],"confidence":0.9}' },
    ]));
    const fixture = await createApplicationFixture();

    const deniedDraft = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${fixture.itemId}/agent-draft`,
      headers: fixture.readOnlyReviewerHeader,
      payload: {},
    });
    expect(deniedDraft.statusCode).toBe(403);

    const deniedGeneric = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-runs',
      headers: fixture.readOnlyReviewerHeader,
      payload: {
        entrypoint: 'review',
        input: {
          item_id: fixture.itemId,
        },
      },
    });
    expect(deniedGeneric.statusCode).toBe(403);
    await app.close();
  });

  it('rejects idempotency key reuse across different application business objects', async () => {
    const app = await buildApp();
    setLlmClientForTesting(successfulApplicationClient());
    const first = await createApplicationFixture();
    const second = await createAdditionalApplicationForOwner({
      enterprise_id: first.enterpriseId,
      owner_id: first.ownerId,
      policy_id: first.policyId,
    });

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${first.applicationId}/agent-assist`,
      headers: first.ownerHeader,
      payload: {
        idempotency_key: 'same-client-retry-key',
      },
    });
    expect(created.statusCode).toBe(200);

    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${second.applicationId}/agent-assist`,
      headers: first.ownerHeader,
      payload: {
        idempotency_key: 'same-client-retry-key',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.message)
      .toBe('idempotency_key was already used for a different agent business object');
    await app.close();
  });

  it('marks real graph dispatch failures as failed with failed step and checkpoint', async () => {
    const app = await buildApp();
    setLlmClientForTesting(new FakeLlmClient([
      { content: 'not json' },
    ]));
    const fixture = await createApplicationFixture();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${fixture.applicationId}/agent-assist`,
      headers: fixture.ownerHeader,
      payload: {},
    });

    expect(response.statusCode).toBe(500);
    const rows = await getRows<{
      status: string;
      current_node: string;
      error_message: string;
    }>(
      `
        SELECT status::text, current_node, error_message
        FROM agent_runs
        WHERE actor_id = $1
        ORDER BY started_at DESC
        LIMIT 1
      `,
      [fixture.ownerId],
    );
    expect(rows[0]).toMatchObject({
      status: 'failed',
      current_node: 'failed',
      error_message: 'llm invalid response',
    });
    expect(rows[0].error_message).not.toMatch(/BAILIAN_API_KEY|Authorization|Bearer/i);

    const failedSteps = await getRows<{ node_name: string; status: string }>(
      `
        SELECT node_name, status::text
        FROM agent_run_steps
        WHERE run_id = (
          SELECT run_id FROM agent_runs WHERE actor_id = $1 ORDER BY started_at DESC LIMIT 1
        )
          AND node_name = 'agent_run_failed'
      `,
      [fixture.ownerId],
    );
    expect(failedSteps).toEqual([{
      node_name: 'agent_run_failed',
      status: 'failed',
    }]);

    const checkpoints = await getRows<{ status: string }>(
      `
        SELECT status
        FROM langgraph_checkpoints
        WHERE run_id = (
          SELECT run_id::text FROM agent_runs WHERE actor_id = $1 ORDER BY started_at DESC LIMIT 1
        )
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [fixture.ownerId],
    );
    expect(checkpoints[0].status).toBe('failed');
    await app.close();
  });

  it('sanitizes LLM configuration errors before persisting agent failure details', async () => {
    const app = await buildApp();
    setLlmClientForTesting(new ConfigurationErrorLlmClient());
    const fixture = await createApplicationFixture();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${fixture.applicationId}/agent-assist`,
      headers: fixture.ownerHeader,
      payload: {},
    });
    expect(response.statusCode).toBe(500);

    const rows = await getRows<{
      error_message: string;
      state: { errors: Array<{ message: string }> };
    }>(
      `
        SELECT error_message, state
        FROM agent_runs
        WHERE actor_id = $1
        ORDER BY started_at DESC
        LIMIT 1
      `,
      [fixture.ownerId],
    );
    expect(rows[0].error_message).toBe('llm configuration error');
    expect(rows[0].state.errors[0].message).toBe('llm configuration error');
    expect(JSON.stringify(rows[0])).not.toMatch(/BAILIAN_API_KEY|Authorization|Bearer/i);
    await app.close();
  });

  it('fails malformed agent JSON schema instead of coercing strings or out-of-range confidence', async () => {
    const app = await buildApp();
    setLlmClientForTesting(new FakeLlmClient([
      {
        content: JSON.stringify({
          action: 'respond_final',
          answer: 'bad confidence',
          confidence: 1.2,
        }),
      },
    ]));
    const fixture = await createApplicationFixture();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${fixture.applicationId}/agent-assist`,
      headers: fixture.ownerHeader,
      payload: {},
    });
    expect(response.statusCode).toBe(500);

    const rows = await getRows<{ error_message: string }>(
      `
        SELECT error_message
        FROM agent_runs
        WHERE actor_id = $1
        ORDER BY started_at DESC
        LIMIT 1
      `,
      [fixture.ownerId],
    );
    expect(rows[0].error_message).toBe('llm invalid response');
    await app.close();
  });

  it('requires item_id for multi-policy application agent runs', async () => {
    const app = await buildApp();
    setLlmClientForTesting(successfulApplicationClient());
    const fixture = await createApplicationFixture({ multiPolicy: true });

    const missingItem = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${fixture.applicationId}/agent-assist`,
      headers: fixture.ownerHeader,
      payload: {},
    });
    expect(missingItem.statusCode).toBe(400);
    expect(missingItem.json().error.message)
      .toBe('item_id is required for multi-policy application agent runs');

    const scoped = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${fixture.applicationId}/agent-assist`,
      headers: fixture.ownerHeader,
      payload: {
        item_id: fixture.itemId,
      },
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().data.status).toBe('completed');
    expect(scoped.json().data.state.input.item_id).toBe(fixture.itemId);
    await app.close();
  });

  it('keeps eligibility fallback tasks isolated per policy item', async () => {
    const app = await buildApp();
    const fixture = await createApplicationFixture({
      multiPolicy: true,
      revenue: 50,
      revenueFailAction: 'manual_review',
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: fixture.ownerHeader,
      payload: {
        application_id: fixture.applicationId,
        item_id: fixture.itemId,
        enterprise_id: fixture.enterpriseId,
        policy_id: fixture.policyId,
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.result).toBe('manual_review');

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: fixture.ownerHeader,
      payload: {
        application_id: fixture.applicationId,
        item_id: fixture.secondItemId,
        enterprise_id: fixture.enterpriseId,
        policy_id: fixture.secondPolicyId,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.result).toBe('manual_review');

    const fallbackRows = await getRows<{ task_id: string; source_id: string; context: Record<string, unknown> }>(
      `
        SELECT task_id::text, source_id, context
        FROM fallback_tasks
        WHERE source_type = 'eligibility'
        ORDER BY created_at ASC, task_id ASC
      `,
    );
    expect(fallbackRows).toHaveLength(2);
    expect(fallbackRows[0].source_id).not.toBe(fallbackRows[1].source_id);
    expect(fallbackRows.map((row) => row.context.item_id).sort()).toEqual(
      [fixture.itemId, fixture.secondItemId].sort(),
    );
    await app.close();
  });

  it('resumes a real application graph after fallback resolution without using mock resume', async () => {
    const app = await buildApp();
    setLlmClientForTesting(manualReviewApplicationClient());
    const fixture = await createApplicationFixture({
      revenue: 50,
      revenueFailAction: 'manual_review',
    });

    const interrupted = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${fixture.applicationId}/agent-assist`,
      headers: fixture.ownerHeader,
      payload: {},
    });
    expect(interrupted.statusCode).toBe(200);
    expect(interrupted.json().data.status).toBe('interrupted');
    const runId = interrupted.json().data.run_id as string;
    const taskId = interrupted.json().data.state.fallback.task_id as string;

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${taskId}/resolve`,
      headers: { authorization: `Bearer dev:${fixture.reviewerId}:system_admin` },
      payload: {
        resolution_type: 'field_patch',
        resolved_payload: {
          confirmed_materials: [],
        },
        comment: 'manual confirmation completed',
      },
    });
    expect(resolved.statusCode).toBe(200);

    setLlmClientForTesting(new FakeLlmClient([
      {
        content: JSON.stringify({
          verdict: 'fail',
          explanation: 'Revenue still does not satisfy the threshold after resume.',
          checked_conditions: [],
          confidence: 0.8,
        }),
      },
      {
        content: JSON.stringify({
          approved: false,
          should_fallback: true,
          reasons: ['manual review still required'],
          confidence: 0.8,
        }),
      },
    ]));
    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/agent-runs/${runId}/resume`,
      headers: fixture.ownerHeader,
      payload: {
        task_id: taskId,
        idempotency_key: 'batch21-real-application-resume',
        resume_payload: {
          confirmed_materials: [],
        },
      },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().data.status).toBe('interrupted');
    expect(resumed.json().data.current_node).toBe('human_fallback');
    expect(resumed.json().data.state.fallback).toMatchObject({
      task_id: taskId,
      reason: 'application_agent_resume_still_requires_review',
    });

    const steps = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-runs/${runId}/steps`,
      headers: fixture.ownerHeader,
    });
    expect(steps.json().data.steps.map((step: { node_name: string }) => step.node_name))
      .toContain('human_fallback_resume');
    expect(steps.json().data.steps.map((step: { node_name: string }) => step.node_name))
      .toContain('human_fallback');
    expect(steps.json().data.steps.map((step: { node_name: string }) => step.node_name))
      .not.toContain('mock_resume');
    await app.close();
  });
});
