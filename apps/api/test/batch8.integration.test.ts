import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  canConnectDatabase,
  clearConfiguredTestUploadDir,
  createApprovedEnterpriseForUser,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';
import { OcrSidecarTestManager } from './ocr-sidecar-test-utils.js';
import { buildBusinessLicenseLowConfidenceFixture } from './ocr-fixture-utils.js';

process.env.FILE_STORAGE_ROOT = '.tmp/test-uploads';
process.env.FILE_UPLOAD_MAX_BYTES = '1024';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;
const ocrSidecar = new OcrSidecarTestManager();

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function registerAndLogin(app: TestApp, input: {
  name: string;
  phone: string;
  password?: string;
  user_type?: string;
}) {
  const password = input.password ?? 'secret123';
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      name: input.name,
      phone: input.phone,
      password,
      user_type: input.user_type,
    },
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { phone: input.phone, password },
  });

  return {
    token: login.json().data.token as string,
    userId: login.json().data.user.user_id as string,
  };
}

async function assignRole(userId: string, roleCode: string) {
  await getRows(
    `
      INSERT INTO user_roles (user_id, role_id)
      SELECT $1, role_id
      FROM roles
      WHERE code = $2
      ON CONFLICT (user_id, role_id) DO NOTHING
    `,
    [userId, roleCode],
  );
}

async function login(app: TestApp, phone: string, password = 'secret123') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { phone, password },
  });
  return response.json().data.token as string;
}

async function createRoleToken(
  app: TestApp,
  roleCode: string,
  phone: string,
  userType = 'admin',
) {
  const { userId } = await registerAndLogin(app, {
    name: `Batch8 ${roleCode}`,
    phone,
    user_type: userType,
  });
  await assignRole(userId, roleCode);
  return login(app, phone);
}

async function bindEnterprise(app: TestApp, token: string, input: {
  enterprise_name: string;
  credit_code: string;
}) {
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'),
  ) as { sub: string };

  return createApprovedEnterpriseForUser({
    userId: claims.sub,
    enterpriseName: input.enterprise_name,
    creditCode: input.credit_code,
  });
}

async function createEnterpriseContext(app: TestApp, phone: string) {
  const user = await registerAndLogin(app, {
    name: 'Batch8 Enterprise',
    phone,
  });
  const enterpriseId = await bindEnterprise(app, user.token, {
    enterprise_name: `Batch8 Enterprise ${phone}`,
    credit_code: `913607HH000000${phone.slice(-4)}`,
  });
  await app.inject({
    method: 'PUT',
    url: '/api/v1/enterprise-profile',
    headers: { authorization: `Bearer ${user.token}` },
    payload: {
      enterprise_id: enterpriseId,
      enterprise_name: `Batch8 Enterprise ${phone}`,
      credit_code: `913607HH000000${phone.slice(-4)}`,
      industry: 'furniture',
      employee_count: 20,
    },
  });
  return { ...user, enterpriseId };
}

async function createPolicy(input: {
  title: string;
  content?: string;
  whitelisted?: boolean;
  conditions?: Array<{
    field_key: string;
    operator: string;
    target_value: unknown;
    fail_action: string;
    evidence_type?: string;
  }>;
}) {
  const policy = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, source_name, status, version, content)
      VALUES ($1, 'manual_import', 'Batch8 Source', 'effective', 'v1', $2)
      RETURNING policy_id::text
    `,
    [input.title, input.content ?? 'batch8 policy content'],
  );
  const policyId = policy[0].policy_id;

  for (const condition of input.conditions ?? []) {
    await getRows(
      `
        INSERT INTO policy_conditions (
          policy_id,
          field_key,
          operator,
          target_value,
          required,
          evidence_type,
          fail_action
        )
        VALUES ($1, $2, $3, $4::jsonb, true, $5, $6)
      `,
      [
        policyId,
        condition.field_key,
        condition.operator,
        JSON.stringify(condition.target_value),
        condition.evidence_type ?? 'profile',
        condition.fail_action,
      ],
    );
  }

  if (input.whitelisted !== false) {
    await getRows(
      'INSERT INTO policy_ai_whitelist (policy_id, enabled) VALUES ($1, true)',
      [policyId],
    );
  }

  return policyId;
}

async function createNeedSupplementApplication(app: TestApp, input: {
  phone: string;
}) {
  const context = await createEnterpriseContext(app, input.phone);
  const policyId = await createPolicy({
    title: `Batch8 OCR Policy ${input.phone}`,
    content: 'business license policy',
  });
  const create = await app.inject({
    method: 'POST',
    url: '/api/v1/applications',
    headers: { authorization: `Bearer ${context.token}` },
    payload: {
      enterprise_id: context.enterpriseId,
      policy_id: policyId,
    },
  });
  const applicationId = create.json().data.application_id as string;
  const itemId = create.json().data.policy_item.item_id as string;

  await app.inject({
    method: 'POST',
    url: `/api/v1/applications/${applicationId}/submit`,
    headers: { authorization: `Bearer ${context.token}` },
  });

  const reviewerToken = await createRoleToken(
    app,
    'reviewer',
    `13${input.phone.slice(2, 11)}8`,
    'government',
  );
  await app.inject({
    method: 'POST',
    url: `/api/v1/review/tasks/${itemId}/decision`,
    headers: { authorization: `Bearer ${reviewerToken}` },
    payload: {
      decision: 'request_supplement',
      comment: 'please supplement business license',
    },
  });

  return {
    ...context,
    policyId,
    applicationId,
    itemId,
  };
}

async function uploadFile(
  app: TestApp,
  token: string,
  enterpriseId: string,
  filename: string,
  content: string,
) {
  const form = new FormData();
  form.set('enterprise_id', enterpriseId);
  form.set('file', new Blob([content], { type: 'text/plain' }), filename);
  return app.inject({
    method: 'POST',
    url: '/api/v1/files',
    headers: { authorization: `Bearer ${token}` },
    payload: form,
  });
}

describeIfDb('batch8 integration', () => {
  beforeAll(async () => {
    process.env.OCR_SERVICE_BASE_URL = ocrSidecar.baseUrl;
    process.env.OCR_SERVICE_TIMEOUT_MS = '15000';
    await prepareDatabase();
    await ocrSidecar.setupSuite();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    await clearConfiguredTestUploadDir();
  });

  afterAll(async () => {
    await clearConfiguredTestUploadDir();
    await ocrSidecar.teardownSuite();
  });

  it('creates and deduplicates policy QA fallback tasks with stable question source id', async () => {
    const app = await buildApp();
    const user = await registerAndLogin(app, {
      name: 'Batch8 QA User',
      phone: '13910000801',
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { question: '  Unknown   Policy??  ' },
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { question: 'unknown policy' },
    });
    const different = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { question: 'another unknown policy' },
    });

    expect(first.json().data.status).toBe('manual_review');
    expect(first.json().data.fallback_task.created).toBe(true);
    expect(duplicate.json().data.fallback_task.created).toBe(false);
    expect(duplicate.json().data.fallback_task.task_id).toBe(
      first.json().data.fallback_task.task_id,
    );
    expect(different.json().data.fallback_task.created).toBe(true);

    const rows = await getRows<{
      source_type: string;
      source_id: string;
      reason: string;
      normalized_question: string;
    }>(
      `
        SELECT
          source_type,
          source_id,
          reason,
          context->>'normalized_question' AS normalized_question
        FROM fallback_tasks
        ORDER BY created_at ASC
      `,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].source_type).toBe('policy_qa');
    expect(rows[0].reason).toBe('policy_qa_manual_review');
    expect(rows[0].source_id).not.toBe('unspecified');
    expect(rows[0].normalized_question).toBe('unknown policy');
    await app.close();
  });

  it('creates eligibility manual_review fallback but does not create need_info fallback', async () => {
    const app = await buildApp();
    const context = await createEnterpriseContext(app, '13910000802');
    const manualPolicyId = await createPolicy({
      title: 'Batch8 Manual Review Eligibility',
      conditions: [
        {
          field_key: 'enterprise_profile.tax_amount',
          operator: 'gte',
          target_value: 100000,
          fail_action: 'manual_review',
        },
      ],
    });
    const needInfoPolicyId = await createPolicy({
      title: 'Batch8 Need Info Eligibility',
      conditions: [
        {
          field_key: 'enterprise_profile.revenue_amount',
          operator: 'gte',
          target_value: 1000000,
          fail_action: 'need_info',
        },
      ],
    });

    const manual = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_id: manualPolicyId,
        profile_snapshot: {
          tax_amount: 1,
        },
      },
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_id: manualPolicyId,
        profile_snapshot: {
          tax_amount: 1,
        },
      },
    });
    const needInfo = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_id: needInfoPolicyId,
      },
    });

    expect(manual.json().data.result).toBe('manual_review');
    expect(manual.json().data.fallback_task.created).toBe(true);
    expect(duplicate.json().data.fallback_task.created).toBe(false);
    expect(needInfo.json().data.result).toBe('need_info');
    expect(needInfo.json().data.fallback_task).toBeNull();

    const rows = await getRows<{ source_type: string; reason: string }>(
      'SELECT source_type, reason FROM fallback_tasks ORDER BY created_at ASC',
    );
    expect(rows).toEqual([
      {
        source_type: 'eligibility',
        reason: 'eligibility_manual_review',
      },
    ]);
    await app.close();
  });

  it('creates OCR fallback task when manual confirmation is required', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000803',
    });
    const upload = await uploadFile(
      app,
      context.token,
      context.enterpriseId,
      'batch8-low-ocr.json',
      buildBusinessLicenseLowConfidenceFixture(),
    );
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        materials: [
          {
            material_type: 'business_license',
            file_id: upload.json().data.file_id,
            mode: 'append',
          },
        ],
      },
    });
    const materialId = supplement.json().data.materials[0].material_id;

    const ocr = await app.inject({
      method: 'POST',
      url: `/api/v1/materials/${materialId}/ocr`,
      headers: { authorization: `Bearer ${context.token}` },
      payload: {},
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/materials/${materialId}/ocr`,
      headers: { authorization: `Bearer ${context.token}` },
      payload: {},
    });

    expect(ocr.statusCode).toBe(200);
    expect(ocr.json().data.requires_manual_confirmation).toBe(true);
    expect(ocr.json().data.fallback_task.created).toBe(true);
    expect(duplicate.json().data.fallback_task.created).toBe(false);

    const rows = await getRows<{
      source_type: string;
      source_id: string;
      reason: string;
    }>(
      'SELECT source_type, source_id, reason FROM fallback_tasks',
    );
    expect(rows).toEqual([
      {
        source_type: 'ocr',
        source_id: materialId,
        reason: 'ocr_requires_manual_confirmation',
      },
    ]);
    await app.close();
  });

  it('enforces fallback list and resolve permissions by role', async () => {
    const app = await buildApp();
    const kbOperatorToken = await createRoleToken(app, 'kb_operator', '13910000804');
    const qaReviewerToken = await createRoleToken(app, 'qa_reviewer', '13910000805');
    const policyAdminToken = await createRoleToken(app, 'policy_admin', '13910000806');
    const reviewerToken = await createRoleToken(
      app,
      'reviewer',
      '13910000807',
      'government',
    );
    const enterprise = await registerAndLogin(app, {
      name: 'Batch8 Forbidden Enterprise',
      phone: '13910000808',
    });

    await getRows(
      `
        INSERT INTO fallback_tasks (source_type, source_id, reason, context)
        VALUES ('policy_qa', 'batch8-permission-source', 'policy_qa_manual_review', '{}'::jsonb)
      `,
    );

    const kbList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fallback-tasks',
      headers: { authorization: `Bearer ${kbOperatorToken}` },
    });
    const qaList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fallback-tasks',
      headers: { authorization: `Bearer ${qaReviewerToken}` },
    });
    const policyAdminList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fallback-tasks',
      headers: { authorization: `Bearer ${policyAdminToken}` },
    });
    const reviewerList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fallback-tasks',
      headers: { authorization: `Bearer ${reviewerToken}` },
    });
    const enterpriseList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fallback-tasks',
      headers: { authorization: `Bearer ${enterprise.token}` },
    });

    const taskId = kbList.json().data.items[0].task_id;
    const qaResolve = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${taskId}/resolve`,
      headers: { authorization: `Bearer ${qaReviewerToken}` },
      payload: {
        resolution_type: 'answer',
        comment: 'qa reviewer cannot resolve',
        resolved_payload: { answer: 'reviewed' },
      },
    });
    const qaDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/fallback-tasks/${taskId}`,
      headers: { authorization: `Bearer ${qaReviewerToken}` },
    });
    const policyAdminDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/fallback-tasks/${taskId}`,
      headers: { authorization: `Bearer ${policyAdminToken}` },
    });
    const reviewerResolve = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${taskId}/resolve`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        resolution_type: 'answer',
        comment: 'government reviewer cannot resolve',
        resolved_payload: { answer: 'reviewed' },
      },
    });

    expect(kbList.statusCode).toBe(200);
    expect(qaList.statusCode).toBe(200);
    expect(qaDetail.statusCode).toBe(200);
    expect(policyAdminList.statusCode).toBe(403);
    expect(policyAdminDetail.statusCode).toBe(403);
    expect(reviewerList.statusCode).toBe(403);
    expect(enterpriseList.statusCode).toBe(403);
    expect(qaResolve.statusCode).toBe(403);
    expect(reviewerResolve.statusCode).toBe(403);
    await app.close();
  });

  it('resolves pending fallback tasks to resolved or closed and persists resolution_type', async () => {
    const app = await buildApp();
    const kbOperatorToken = await createRoleToken(app, 'kb_operator', '13910000809');
    const systemAdminToken = await createRoleToken(app, 'system_admin', '13910000810');
    const tasks = await getRows<{ task_id: string }>(
      `
        INSERT INTO fallback_tasks (source_type, source_id, reason, context)
        VALUES
          ('policy_qa', 'batch8-resolve-source', 'policy_qa_manual_review', '{}'::jsonb),
          ('ocr', 'batch8-close-source', 'ocr_requires_manual_confirmation', '{}'::jsonb)
        RETURNING task_id::text
      `,
    );

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${tasks[0].task_id}/resolve`,
      headers: { authorization: `Bearer ${kbOperatorToken}` },
      payload: {
        resolution_type: 'answer',
        comment: '人工确认答案',
        resolved_payload: { answer: '人工确认答案' },
      },
    });
    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${tasks[1].task_id}/resolve`,
      headers: { authorization: `Bearer ${systemAdminToken}` },
      payload: {
        resolution_type: 'close',
        comment: 'not actionable',
        resolved_payload: { reason: 'not actionable' },
      },
    });
    const repeat = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${tasks[0].task_id}/resolve`,
      headers: { authorization: `Bearer ${kbOperatorToken}` },
      payload: {
        resolution_type: 'answer',
        comment: 'repeat',
        resolved_payload: { answer: 'repeat' },
      },
    });
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${tasks[0].task_id}/resolve`,
      headers: { authorization: `Bearer ${kbOperatorToken}` },
      payload: {
        resolution_type: 'transfer_department',
        comment: 'invalid type',
        resolved_payload: {},
      },
    });
    const missingComment = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fallback-tasks/${tasks[0].task_id}/resolve`,
      headers: { authorization: `Bearer ${kbOperatorToken}` },
      payload: {
        resolution_type: 'answer',
        resolved_payload: { answer: 'missing comment' },
      },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data.status).toBe('resolved');
    expect(resolved.json().data.resolution_type).toBe('answer');
    expect(closed.statusCode).toBe(200);
    expect(closed.json().data.status).toBe('closed');
    expect(closed.json().data.resolution_type).toBe('close');
    expect(repeat.statusCode).toBe(409);
    expect(invalid.statusCode).toBe(400);
    expect(missingComment.statusCode).toBe(400);

    const rows = await getRows<{
      status: string;
      resolution_type: string;
      resolved_by: string | null;
      resolved_at: string | null;
    }>(
      `
        SELECT status::text, resolution_type, resolved_by::text, resolved_at::text
        FROM fallback_tasks
        ORDER BY source_id ASC
      `,
    );
    const audits = await getRows<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'fallback.task.resolve'",
    );
    expect(rows).toEqual([
      {
        status: 'closed',
        resolution_type: 'close',
        resolved_by: expect.any(String),
        resolved_at: expect.any(String),
      },
      {
        status: 'resolved',
        resolution_type: 'answer',
        resolved_by: expect.any(String),
        resolved_at: expect.any(String),
      },
    ]);
    expect(audits).toHaveLength(2);
    await app.close();
  });
});
