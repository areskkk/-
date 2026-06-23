import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  canConnectDatabase,
  createApprovedEnterpriseForUser,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function registerAndLogin(app: TestApp, input: {
  name: string;
  phone: string;
  password: string;
  user_type?: string;
}) {
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: input,
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      phone: input.phone,
      password: input.password,
    },
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

async function createGovernmentToken(
  app: TestApp,
  roleCode: 'window_staff' | 'reviewer' | 'department_lead' | 'system_admin',
  phone: string,
) {
  const { userId } = await registerAndLogin(app, {
    name: `Gov ${roleCode}`,
    phone,
    password: 'secret123',
    user_type: 'government',
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

async function createEffectivePolicy(title = 'Batch5 Policy') {
  const rows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, status, version, content)
      VALUES ($1, 'manual_import', 'effective', 'v1', 'batch5 policy content')
      RETURNING policy_id
    `,
    [title],
  );
  return rows[0].policy_id;
}

async function createSubmittedApplication(app: TestApp, input: {
  phone: string;
  enterpriseName: string;
  creditCode: string;
  withMaterial?: boolean;
}) {
  const { token: enterpriseToken } = await registerAndLogin(app, {
    name: input.enterpriseName,
    phone: input.phone,
    password: 'secret123',
  });
  const enterpriseId = await bindEnterprise(app, enterpriseToken, {
    enterprise_name: input.enterpriseName,
    credit_code: input.creditCode,
  });

  await app.inject({
    method: 'PUT',
    url: '/api/v1/enterprise-profile',
    headers: { authorization: `Bearer ${enterpriseToken}` },
    payload: {
      enterprise_id: enterpriseId,
      enterprise_name: input.enterpriseName,
      credit_code: input.creditCode,
      industry: 'furniture',
      employee_count: 24,
      profile_json: { batch: 5 },
    },
  });

  const policyId = await createEffectivePolicy(`${input.enterpriseName} Policy`);
  const create = await app.inject({
    method: 'POST',
    url: '/api/v1/applications',
    headers: { authorization: `Bearer ${enterpriseToken}` },
    payload: {
      enterprise_id: enterpriseId,
      policy_id: policyId,
    },
  });
  const applicationId = create.json().data.application_id as string;
  const itemId = create.json().data.policy_item.item_id as string;

  if (input.withMaterial) {
    const form = new FormData();
    form.set('enterprise_id', enterpriseId);
    form.set('file', new Blob(['batch5 file'], { type: 'text/plain' }), 'batch5.txt');
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { authorization: `Bearer ${enterpriseToken}` },
      payload: form,
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/materials',
      headers: { authorization: `Bearer ${enterpriseToken}` },
      payload: {
        application_id: applicationId,
        material_type: 'business_license',
        file_id: upload.json().data.file_id,
      },
    });
  }

  await app.inject({
    method: 'POST',
    url: `/api/v1/applications/${applicationId}/submit`,
    headers: { authorization: `Bearer ${enterpriseToken}` },
  });

  return {
    enterpriseToken,
    enterpriseId,
    applicationId,
    itemId,
    policyId,
  };
}

describeIfDb('batch5 integration', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
  });

  it('allows reviewer to list submitted tasks and excludes draft tasks', async () => {
    const app = await buildApp();
    const reviewerToken = await createGovernmentToken(
      app,
      'reviewer',
      '13910000501',
    );
    const submitted = await createSubmittedApplication(app, {
      phone: '13910000502',
      enterpriseName: 'Review Submitted Enterprise',
      creditCode: '913607EE0000000502',
    });

    const draftEnterprise = await registerAndLogin(app, {
      name: 'Draft Enterprise User',
      phone: '13910000503',
      password: 'secret123',
    });
    const enterpriseId = await bindEnterprise(app, draftEnterprise.token, {
      enterprise_name: 'Review Draft Enterprise',
      credit_code: '913607EE0000000503',
    });
    const policyId = await createEffectivePolicy('Draft Hidden Policy');
    const draft = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${draftEnterprise.token}` },
      payload: { enterprise_id: enterpriseId, policy_id: policyId },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/review/tasks?page=1&page_size=20',
      headers: { authorization: `Bearer ${reviewerToken}` },
    });

    expect(list.statusCode).toBe(200);
    const itemIds = list.json().data.items.map((item: { item_id: string }) => item.item_id);
    expect(itemIds).toContain(submitted.itemId);
    expect(itemIds).not.toContain(draft.json().data.policy_item.item_id);
    await app.close();
  });

  it('returns review detail from existing facts and file metadata only', async () => {
    const app = await buildApp();
    const reviewerToken = await createGovernmentToken(
      app,
      'reviewer',
      '13910000504',
    );
    const submitted = await createSubmittedApplication(app, {
      phone: '13910000505',
      enterpriseName: 'Review Detail Enterprise',
      creditCode: '913607EE0000000505',
      withMaterial: true,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/review/tasks/${submitted.itemId}`,
      headers: { authorization: `Bearer ${reviewerToken}` },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.task.item_id).toBe(submitted.itemId);
    expect(detail.json().data.profile_snapshot.industry).toBe('furniture');
    expect(detail.json().data.materials).toHaveLength(1);
    expect(detail.json().data.materials[0]).toMatchObject({
      original_filename: 'batch5.txt',
      mime_type: 'text/plain',
      ocr_status: 'pending',
      security_level: 'L3',
    });
    expect(detail.json().data.materials[0].storage_key).toBeUndefined();
    expect(detail.json().data.materials[0].download_url).toBeUndefined();
    expect(detail.json().data.materials[0].preview_url).toBeUndefined();
    await app.close();
  });

  it('enforces review read and decision permissions by role', async () => {
    const app = await buildApp();
    const enterprise = await registerAndLogin(app, {
      name: 'Forbidden Enterprise User',
      phone: '13910000506',
      password: 'secret123',
    });
    const windowStaffToken = await createGovernmentToken(
      app,
      'window_staff',
      '13910000507',
    );
    const submitted = await createSubmittedApplication(app, {
      phone: '13910000508',
      enterpriseName: 'Permission Review Enterprise',
      creditCode: '913607EE0000000508',
    });

    const enterpriseList = await app.inject({
      method: 'GET',
      url: '/api/v1/review/tasks',
      headers: { authorization: `Bearer ${enterprise.token}` },
    });
    const windowList = await app.inject({
      method: 'GET',
      url: '/api/v1/review/tasks',
      headers: { authorization: `Bearer ${windowStaffToken}` },
    });
    const windowDecision = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemId}/decision`,
      headers: { authorization: `Bearer ${windowStaffToken}` },
      payload: {
        decision: 'approve',
        comment: '窗口人员不得决策',
      },
    });

    expect(enterpriseList.statusCode).toBe(403);
    expect(windowList.statusCode).toBe(200);
    expect(windowDecision.statusCode).toBe(403);
    await app.close();
  });

  it('approves submitted task and syncs policy item and application status', async () => {
    const app = await buildApp();
    const reviewerToken = await createGovernmentToken(
      app,
      'reviewer',
      '13910000509',
    );
    const submitted = await createSubmittedApplication(app, {
      phone: '13910000510',
      enterpriseName: 'Approve Enterprise',
      creditCode: '913607EE0000000510',
    });

    const decision = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemId}/decision`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        decision: 'approve',
        comment: '人工审核通过',
      },
    });

    expect(decision.statusCode).toBe(200);
    expect(decision.json().data.status).toBe('approved');
    expect(decision.json().data.application_status).toBe('approved');

    const items = await getRows<{ status: string; review_result: string }>(
      'SELECT status, review_result FROM application_policy_items WHERE item_id = $1',
      [submitted.itemId],
    );
    const applications = await getRows<{ status: string }>(
      'SELECT status FROM applications WHERE application_id = $1',
      [submitted.applicationId],
    );
    const records = await getRows<{ action: string; comment: string }>(
      'SELECT action, comment FROM review_records WHERE item_id = $1',
      [submitted.itemId],
    );
    const audits = await getRows<{ action: string; detail: { comment: string } }>(
      "SELECT action, detail FROM audit_logs WHERE action = 'review.approve'",
    );
    const enterpriseDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${submitted.applicationId}`,
      headers: { authorization: `Bearer ${submitted.enterpriseToken}` },
    });

    expect(items[0]).toEqual({ status: 'approved', review_result: 'approved' });
    expect(applications[0].status).toBe('approved');
    expect(records[0]).toEqual({ action: 'approve', comment: '人工审核通过' });
    expect(audits).toHaveLength(1);
    expect(audits[0].detail.comment).toBe('人工审核通过');
    expect(enterpriseDetail.json().data.status).toBe('approved');
    await app.close();
  });

  it('rejects submitted task and writes review record and audit log', async () => {
    const app = await buildApp();
    const leadToken = await createGovernmentToken(
      app,
      'department_lead',
      '13910000511',
    );
    const submitted = await createSubmittedApplication(app, {
      phone: '13910000512',
      enterpriseName: 'Reject Enterprise',
      creditCode: '913607EE0000000512',
    });

    const decision = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemId}/decision`,
      headers: { authorization: `Bearer ${leadToken}` },
      payload: {
        decision: 'reject',
        comment: '人工审核不通过',
      },
    });

    expect(decision.statusCode).toBe(200);

    const rows = await getRows<{
      application_status: string;
      item_status: string;
      review_result: string;
      action: string;
    }>(
      `
        SELECT
          a.status::text AS application_status,
          api.status::text AS item_status,
          api.review_result,
          rr.action
        FROM applications a
        INNER JOIN application_policy_items api ON api.application_id = a.application_id
        INNER JOIN review_records rr ON rr.item_id = api.item_id
        WHERE api.item_id = $1
      `,
      [submitted.itemId],
    );
    expect(rows[0]).toEqual({
      application_status: 'rejected',
      item_status: 'rejected',
      review_result: 'rejected',
      action: 'reject',
    });
    await app.close();
  });

  it('requires comment for request_supplement and keeps reason in review and audit', async () => {
    const app = await buildApp();
    const reviewerToken = await createGovernmentToken(
      app,
      'reviewer',
      '13910000513',
    );
    const submitted = await createSubmittedApplication(app, {
      phone: '13910000514',
      enterpriseName: 'Supplement Enterprise',
      creditCode: '913607EE0000000514',
    });

    const missingComment = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemId}/decision`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        decision: 'request_supplement',
      },
    });
    const decision = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemId}/decision`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        decision: 'request_supplement',
        comment: '请补充营业执照清晰扫描件',
      },
    });

    expect(missingComment.statusCode).toBe(400);
    expect(decision.statusCode).toBe(200);
    expect(decision.json().data.status).toBe('need_supplement');

    const records = await getRows<{ action: string; comment: string }>(
      'SELECT action, comment FROM review_records WHERE item_id = $1',
      [submitted.itemId],
    );
    const audits = await getRows<{ detail: { comment: string } }>(
      "SELECT detail FROM audit_logs WHERE action = 'review.request_supplement'",
    );
    expect(records[0]).toEqual({
      action: 'request_supplement',
      comment: '请补充营业执照清晰扫描件',
    });
    expect(audits[0].detail.comment).toBe('请补充营业执照清晰扫描件');
    await app.close();
  });

  it('rejects decisions for draft and already final tasks', async () => {
    const app = await buildApp();
    const reviewerToken = await createGovernmentToken(
      app,
      'reviewer',
      '13910000515',
    );
    const enterprise = await registerAndLogin(app, {
      name: 'Draft Decision User',
      phone: '13910000516',
      password: 'secret123',
    });
    const enterpriseId = await bindEnterprise(app, enterprise.token, {
      enterprise_name: 'Draft Decision Enterprise',
      credit_code: '913607EE0000000516',
    });
    const policyId = await createEffectivePolicy('Draft Decision Policy');
    const draft = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${enterprise.token}` },
      payload: {
        enterprise_id: enterpriseId,
        policy_id: policyId,
      },
    });
    const submitted = await createSubmittedApplication(app, {
      phone: '13910000517',
      enterpriseName: 'Final Decision Enterprise',
      creditCode: '913607EE0000000517',
    });

    const draftDecision = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${draft.json().data.policy_item.item_id}/decision`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        decision: 'approve',
        comment: 'draft cannot pass',
      },
    });
    const firstDecision = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemId}/decision`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        decision: 'approve',
        comment: 'first pass',
      },
    });
    const secondDecision = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemId}/decision`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        decision: 'reject',
        comment: 'cannot repeat',
      },
    });

    expect(draftDecision.statusCode).toBe(409);
    expect(firstDecision.statusCode).toBe(200);
    expect(secondDecision.statusCode).toBe(409);
    await app.close();
  });
});
