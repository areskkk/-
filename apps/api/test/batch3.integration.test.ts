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

async function registerAndLogin(app: Awaited<ReturnType<typeof buildApp>>, input: {
  name: string;
  phone: string;
  password: string;
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

  return login.json().data.token as string;
}

async function createBoundEnterprise(
  token: string,
  input: {
    enterprise_name: string;
    credit_code: string;
  },
) {
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'),
  ) as { sub: string };

  return createApprovedEnterpriseForUser({
    userId: claims.sub,
    enterpriseName: input.enterprise_name,
    creditCode: input.credit_code,
  });
}

async function createEffectivePolicy() {
  const rows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, status, version, content)
      VALUES ('Single Policy', 'manual_import', 'effective', 'v1', 'single policy content')
      RETURNING policy_id
    `,
  );
  return rows[0].policy_id;
}

describeIfDb('batch3 integration', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
  });

  it('creates single-policy draft successfully', async () => {
    const app = await buildApp();
    const token = await registerAndLogin(app, {
      name: 'Draft User',
      phone: '13810000001',
      password: 'secret123',
    });

    const enterpriseId = await createBoundEnterprise(token, {
      enterprise_name: 'Draft Enterprise',
      credit_code: '913607CC0000000001',
    });
    const policyId = await createEffectivePolicy();

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enterprise_id: enterpriseId,
        policy_id: policyId,
      },
    });

    expect(create.statusCode).toBe(200);
    expect(create.json().data.status).toBe('draft');

    const applications = await getRows<{ profile_snapshot_id: string | null; status: string }>(
      'SELECT profile_snapshot_id, status FROM applications',
    );
    const items = await getRows<{ status: string; policy_id: string }>(
      'SELECT status, policy_id FROM application_policy_items',
    );
    expect(applications).toHaveLength(1);
    expect(applications[0].profile_snapshot_id).toBeNull();
    expect(applications[0].status).toBe('draft');
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('draft');
    expect(items[0].policy_id).toBe(policyId);
    await app.close();
  });

  it('list returns only current enterprise applications', async () => {
    const app = await buildApp();
    const tokenA = await registerAndLogin(app, {
      name: 'List User A',
      phone: '13810000002',
      password: 'secret123',
    });
    const tokenB = await registerAndLogin(app, {
      name: 'List User B',
      phone: '13810000003',
      password: 'secret123',
    });

    const enterpriseA = await createBoundEnterprise(tokenA, {
      enterprise_name: 'Enterprise A',
      credit_code: '913607CC0000000002',
    });
    const enterpriseB = await createBoundEnterprise(tokenB, {
      enterprise_name: 'Enterprise B',
      credit_code: '913607CC0000000003',
    });

    const policyId = await createEffectivePolicy();
    await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { enterprise_id: enterpriseA, policy_id: policyId },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { enterprise_id: enterpriseB, policy_id: policyId },
    });

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/applications?enterprise_id=${enterpriseA}&page=1&page_size=20`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().data.items).toHaveLength(1);
    expect(list.json().data.items[0].enterprise_id).toBe(enterpriseA);
    await app.close();
  });

  it('detail enforces enterprise boundary', async () => {
    const app = await buildApp();
    const tokenA = await registerAndLogin(app, {
      name: 'Detail User A',
      phone: '13810000004',
      password: 'secret123',
    });
    const tokenB = await registerAndLogin(app, {
      name: 'Detail User B',
      phone: '13810000005',
      password: 'secret123',
    });

    const enterpriseA = await createBoundEnterprise(tokenA, {
      enterprise_name: 'Detail Enterprise A',
      credit_code: '913607CC0000000004',
    });
    await createBoundEnterprise(tokenB, {
      enterprise_name: 'Detail Enterprise B',
      credit_code: '913607CC0000000005',
    });
    const policyId = await createEffectivePolicy();
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { enterprise_id: enterpriseA, policy_id: policyId },
    });
    const applicationId = create.json().data.application_id;

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${applicationId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(detail.statusCode).toBe(403);
    await app.close();
  });

  it('submit generates snapshot and updates application and policy item to submitted', async () => {
    const app = await buildApp();
    const token = await registerAndLogin(app, {
      name: 'Submit User',
      phone: '13810000006',
      password: 'secret123',
    });

    const enterpriseId = await createBoundEnterprise(token, {
      enterprise_name: 'Submit Enterprise',
      credit_code: '913607CC0000000006',
    });

    await app.inject({
      method: 'PUT',
      url: '/api/v1/enterprise-profile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enterprise_id: enterpriseId,
        enterprise_name: 'Submit Enterprise',
        credit_code: '913607CC0000000006',
        industry: 'furniture',
        employee_count: 30,
        tax_amount: 1000,
        profile_json: { note: 'before-submit' },
      },
    });

    const policyId = await createEffectivePolicy();
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${token}` },
      payload: { enterprise_id: enterpriseId, policy_id: policyId },
    });
    const applicationId = create.json().data.application_id;

    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${applicationId}/submit`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(submit.statusCode).toBe(200);
    expect(submit.json().data.status).toBe('submitted');
    expect(submit.json().data.profile_snapshot_id).toBeTruthy();

    const applications = await getRows<{
      status: string;
      profile_snapshot_id: string | null;
    }>('SELECT status, profile_snapshot_id FROM applications WHERE application_id = $1', [
      applicationId,
    ]);
    const items = await getRows<{ status: string }>(
      'SELECT status FROM application_policy_items WHERE application_id = $1',
      [applicationId],
    );
    expect(applications[0].status).toBe('submitted');
    expect(applications[0].profile_snapshot_id).toBeTruthy();
    expect(items[0].status).toBe('submitted');
    await app.close();
  });

  it('snapshot remains unchanged after current profile is updated post-submit', async () => {
    const app = await buildApp();
    const token = await registerAndLogin(app, {
      name: 'Snapshot User',
      phone: '13810000007',
      password: 'secret123',
    });

    const enterpriseId = await createBoundEnterprise(token, {
      enterprise_name: 'Snapshot Enterprise',
      credit_code: '913607CC0000000007',
    });

    await app.inject({
      method: 'PUT',
      url: '/api/v1/enterprise-profile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enterprise_id: enterpriseId,
        enterprise_name: 'Snapshot Enterprise',
        credit_code: '913607CC0000000007',
        industry: 'furniture',
        employee_count: 20,
        profile_json: { version: 'before' },
      },
    });

    const policyId = await createEffectivePolicy();
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${token}` },
      payload: { enterprise_id: enterpriseId, policy_id: policyId },
    });
    const applicationId = create.json().data.application_id;

    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${applicationId}/submit`,
      headers: { authorization: `Bearer ${token}` },
    });
    const snapshotId = submit.json().data.profile_snapshot_id;

    await app.inject({
      method: 'PUT',
      url: '/api/v1/enterprise-profile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enterprise_id: enterpriseId,
        enterprise_name: 'Snapshot Enterprise',
        credit_code: '913607CC0000000007',
        industry: 'updated-industry',
        employee_count: 99,
        profile_json: { version: 'after' },
      },
    });

    const snapshots = await getRows<{
      industry: string;
      employee_count: number;
      profile_json: { version: string };
    }>(
      `
        SELECT industry, employee_count, profile_json
        FROM enterprise_profile_snapshots
        WHERE snapshot_id = $1
      `,
      [snapshotId],
    );

    expect(snapshots[0].industry).toBe('furniture');
    expect(snapshots[0].employee_count).toBe(20);
    expect(snapshots[0].profile_json.version).toBe('before');
    await app.close();
  });

  it('non-draft application cannot be submitted twice', async () => {
    const app = await buildApp();
    const token = await registerAndLogin(app, {
      name: 'Twice Submit User',
      phone: '13810000008',
      password: 'secret123',
    });

    const enterpriseId = await createBoundEnterprise(token, {
      enterprise_name: 'Twice Submit Enterprise',
      credit_code: '913607CC0000000008',
    });

    await app.inject({
      method: 'PUT',
      url: '/api/v1/enterprise-profile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enterprise_id: enterpriseId,
        enterprise_name: 'Twice Submit Enterprise',
        credit_code: '913607CC0000000008',
        industry: 'furniture',
      },
    });

    const policyId = await createEffectivePolicy();
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${token}` },
      payload: { enterprise_id: enterpriseId, policy_id: policyId },
    });
    const applicationId = create.json().data.application_id;

    const firstSubmit = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${applicationId}/submit`,
      headers: { authorization: `Bearer ${token}` },
    });
    const secondSubmit = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${applicationId}/submit`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(firstSubmit.statusCode).toBe(200);
    expect(secondSubmit.statusCode).toBe(409);
    await app.close();
  });

  it('submit fails when bound policy is not effective', async () => {
    const app = await buildApp();
    const token = await registerAndLogin(app, {
      name: 'Inactive Policy User',
      phone: '13810000009',
      password: 'secret123',
    });

    const enterpriseId = await createBoundEnterprise(token, {
      enterprise_name: 'Inactive Policy Enterprise',
      credit_code: '913607CC0000000009',
    });

    await app.inject({
      method: 'PUT',
      url: '/api/v1/enterprise-profile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enterprise_id: enterpriseId,
        enterprise_name: 'Inactive Policy Enterprise',
        credit_code: '913607CC0000000009',
        industry: 'furniture',
      },
    });

    const rows = await getRows<{ policy_id: string }>(
      `
        INSERT INTO policies (title, source_type, status, version, content)
        VALUES ('Draft Policy For Submit', 'manual_import', 'draft', 'v1', 'draft body')
        RETURNING policy_id
      `,
    );
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${token}` },
      payload: { enterprise_id: enterpriseId, policy_id: rows[0].policy_id },
    });

    expect(create.statusCode).toBe(404);
    await app.close();
  });
});
