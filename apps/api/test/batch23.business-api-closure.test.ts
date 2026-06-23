import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setOcrProviderForTest } from '../src/modules/ocr/providers/ocr-provider.factory.js';
import { type OcrProvider } from '../src/modules/ocr/providers/ocr-provider.js';
import {
  canConnectDatabase,
  clearConfiguredTestUploadDir,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;

type TestApp = Awaited<ReturnType<typeof buildApp>>;

const matchingBindingOcrProvider: OcrProvider = {
  async analyze() {
    return {
      material_type: 'business_license',
      fields: {
        enterprise_name: 'Batch23 Binding Enterprise',
        credit_code: '913607BT0000230201',
      },
      field_confidence: {
        enterprise_name: 0.96,
        credit_code: 0.95,
      },
      overall_confidence: 0.95,
      warnings: [],
    };
  },
};

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

async function createTokenWithRole(
  app: TestApp,
  roleCode: string,
  phone: string,
  userType = 'government',
) {
  const user = await registerAndLogin(app, {
    name: `Batch23 ${roleCode}`,
    phone,
    password: 'secret123',
    user_type: userType,
  });
  await assignRole(user.userId, roleCode);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { phone, password: 'secret123' },
  });
  return login.json().data.token as string;
}

async function createEnterpriseOwner(app: TestApp, input: {
  phone: string;
  enterpriseName: string;
  creditCode: string;
}) {
  const user = await registerAndLogin(app, {
    name: input.enterpriseName,
    phone: input.phone,
    password: 'secret123',
  });
  const rows = await getRows<{ enterprise_id: string }>(
    `
      INSERT INTO enterprises (name, credit_code, status)
      VALUES ($1, $2, 'active')
      RETURNING enterprise_id::text
    `,
    [input.enterpriseName, input.creditCode],
  );
  await getRows(
    `
      INSERT INTO enterprise_accounts (enterprise_id, user_id, role, auth_status)
      VALUES ($1, $2, 'owner', 'manual_approved')
    `,
    [rows[0].enterprise_id, user.userId],
  );
  await assignRole(user.userId, 'owner');
  return {
    token: user.token,
    userId: user.userId,
    enterpriseId: rows[0].enterprise_id,
  };
}

async function createEffectivePolicy(title: string) {
  const rows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, status, version, content)
      VALUES ($1, 'manual_import', 'effective', 'v1', 'batch23 policy')
      RETURNING policy_id::text
    `,
    [title],
  );
  return rows[0].policy_id;
}

async function createEffectiveWhitelistedPolicyWithCreditCondition(
  title: string,
  creditCode: string,
) {
  const policyId = await createEffectivePolicy(title);
  await getRows(
    `
      INSERT INTO policy_ai_whitelist (policy_id, enabled)
      VALUES ($1, true)
      ON CONFLICT (policy_id) DO UPDATE SET enabled = true
    `,
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
        fail_action
      )
      VALUES ($1, 'ocr.business_license.credit_code', 'eq', $2::jsonb, true, 'ocr', 'eligible')
    `,
    [policyId, JSON.stringify(creditCode)],
  );
  return policyId;
}

async function uploadBindingFile(app: TestApp, token: string) {
  const form = new FormData();
  form.set('purpose', 'enterprise_binding');
  form.set('file', new Blob(['binding license'], { type: 'text/plain' }), 'license.txt');
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/files',
    headers: { authorization: `Bearer ${token}` },
    payload: form,
  });
  expect(response.statusCode).toBe(200);
  return response.json().data.file_id as string;
}

async function createMultiPolicyApplication(app: TestApp) {
  const enterprise = await createEnterpriseOwner(app, {
    phone: '13923000001',
    enterpriseName: 'Batch23 Multi Enterprise',
    creditCode: '913607BT0000230001',
  });
  await app.inject({
    method: 'PUT',
    url: '/api/v1/enterprise-profile',
    headers: { authorization: `Bearer ${enterprise.token}` },
    payload: {
      enterprise_id: enterprise.enterpriseId,
      enterprise_name: 'Batch23 Multi Enterprise',
      credit_code: '913607BT0000230001',
      industry: 'furniture',
      profile_json: {},
    },
  });
  const policyA = await createEffectivePolicy('Batch23 Policy A');
  const policyB = await createEffectivePolicy('Batch23 Policy B');
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/applications',
    headers: { authorization: `Bearer ${enterprise.token}` },
    payload: {
      enterprise_id: enterprise.enterpriseId,
      policy_ids: [policyA, policyB],
    },
  });
  const applicationId = created.json().data.application_id as string;
  const itemIds = created.json().data.policy_items
    .map((item: { item_id: string }) => item.item_id) as string[];
  await app.inject({
    method: 'POST',
    url: `/api/v1/applications/${applicationId}/submit`,
    headers: { authorization: `Bearer ${enterprise.token}` },
  });
  return {
    ...enterprise,
    applicationId,
    itemIds,
    policyIds: [policyA, policyB],
  };
}

describeIfDb('batch23 business API closure', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    await clearConfiguredTestUploadDir();
    setOcrProviderForTest(matchingBindingOcrProvider);
  });

  afterEach(() => {
    setOcrProviderForTest(null);
  });

  it('allows enterprise_binding pre-upload and binds first enterprise transactionally', async () => {
    const app = await buildApp();
    const user = await registerAndLogin(app, {
      name: 'Batch23 Binding User',
      phone: '13923000201',
      password: 'secret123',
    });
    const fileId = await uploadBindingFile(app, user.token);

    const bind = await app.inject({
      method: 'POST',
      url: '/api/v1/enterprises/bind',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        enterprise_name: 'Batch23 Binding Enterprise',
        credit_code: '913607BT0000230201',
        license_file_id: fileId,
      },
    });

    expect(bind.statusCode).toBe(200);
    expect(bind.json().data.status).toBe('agent_approved');
    const files = await getRows<{ enterprise_id: string | null; purpose: string }>(
      'SELECT enterprise_id::text, purpose FROM files WHERE file_id = $1',
      [fileId],
    );
    const accounts = await getRows<{ auth_status: string }>(
      'SELECT auth_status::text FROM enterprise_accounts WHERE user_id = $1',
      [user.userId],
    );
    expect(files[0].enterprise_id).toBeTruthy();
    expect(files[0].purpose).toBe('enterprise_binding');
    expect(accounts[0].auth_status).toBe('agent_approved');
    await app.close();
  });

  it('does not create enterprise when binding file purpose is invalid', async () => {
    const app = await buildApp();
    const user = await registerAndLogin(app, {
      name: 'Batch23 Invalid Binding User',
      phone: '13923000202',
      password: 'secret123',
    });
    await getRows(
      `
        INSERT INTO files (
          uploader_user_id,
          original_filename,
          mime_type,
          byte_size,
          file_hash,
          storage_key,
          purpose
        )
        VALUES ($1, 'bad.txt', 'text/plain', 3, 'hash', 'bad-key', 'enterprise_resource')
      `,
      [user.userId],
    );
    const file = await getRows<{ file_id: string }>(
      'SELECT file_id::text FROM files WHERE uploader_user_id = $1',
      [user.userId],
    );
    const bind = await app.inject({
      method: 'POST',
      url: '/api/v1/enterprises/bind',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        enterprise_name: 'Batch23 Invalid Purpose Enterprise',
        credit_code: '913607BT0000230202',
        license_file_id: file[0].file_id,
      },
    });

    expect(bind.statusCode).toBe(400);
    const enterprises = await getRows(
      'SELECT enterprise_id FROM enterprises WHERE credit_code = $1',
      ['913607BT0000230202'],
    );
    expect(enterprises).toHaveLength(0);
    await app.close();
  });

  it('does not let pending binding access enterprise resources', async () => {
    const app = await buildApp();
    const user = await registerAndLogin(app, {
      name: 'Batch23 Pending User',
      phone: '13923000203',
      password: 'secret123',
    });
    const enterprise = await getRows<{ enterprise_id: string }>(
      `
        INSERT INTO enterprises (name, credit_code, status)
        VALUES ('Batch23 Pending Enterprise', '913607BT0000230203', 'pending')
        RETURNING enterprise_id::text
      `,
    );
    await getRows(
      `
        INSERT INTO enterprise_accounts (enterprise_id, user_id, role, auth_status)
        VALUES ($1, $2, 'owner', 'pending')
      `,
      [enterprise[0].enterprise_id, user.userId],
    );

    const profile = await app.inject({
      method: 'PUT',
      url: '/api/v1/enterprise-profile',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        enterprise_id: enterprise[0].enterprise_id,
        enterprise_name: 'Batch23 Pending Enterprise',
        credit_code: '913607BT0000230203',
      },
    });
    const createApp = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        enterprise_id: enterprise[0].enterprise_id,
        policy_id: await createEffectivePolicy('Batch23 Pending Policy'),
      },
    });

    expect(profile.statusCode).toBe(403);
    expect(createApp.statusCode).toBe(403);
    await app.close();
  });

  it('imports enterprise profiles from admin API with credit_code upsert', async () => {
    const app = await buildApp();
    const adminToken = await createTokenWithRole(
      app,
      'system_admin',
      '13923000101',
      'admin',
    );

    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/enterprise-profiles/import',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        idempotency_key: 'batch23_profile_import',
        mode: 'upsert',
        source: 'government_import',
        rows: [{
          enterprise_name: 'Batch23 Import Enterprise',
          credit_code: '913607BT0000230101',
          industry: 'furniture',
          employee_count: 42,
          profile_json: { imported: true },
        }],
      },
    });

    expect(imported.statusCode).toBe(200);
    expect(imported.json().data).toMatchObject({
      total: 1,
      inserted: 1,
      updated: 0,
      failed: 0,
    });
    const profiles = await getRows<{ enterprise_name: string; industry: string }>(
      'SELECT enterprise_name, industry FROM enterprise_profiles WHERE credit_code = $1',
      ['913607BT0000230101'],
    );
    expect(profiles[0]).toEqual({
      enterprise_name: 'Batch23 Import Enterprise',
      industry: 'furniture',
    });
    await app.close();
  });

  it('supports multi-policy create, precheck, supplement request and aggregate decision', async () => {
    const app = await buildApp();
    const reviewerToken = await createTokenWithRole(app, 'reviewer', '13923000102');
    const submitted = await createMultiPolicyApplication(app);

    const precheck = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemIds[0]}/precheck`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { idempotency_key: 'batch23_precheck' },
    });

    expect(precheck.statusCode).toBe(200);
    expect(precheck.json().data.status).toBe('pre_reviewing');
    const taskList = await app.inject({
      method: 'GET',
      url: '/api/v1/review/tasks?status=pre_reviewing',
      headers: { authorization: `Bearer ${reviewerToken}` },
    });
    expect(taskList.statusCode).toBe(200);
    expect(
      taskList.json().data.items.map((item: { item_id: string }) => item.item_id),
    ).toContain(submitted.itemIds[0]);
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemIds[0]}/supplement-request`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        reason: '鏉愭枡闇€瑕佽ˉ姝?',
        required_materials: [{
          material_type: 'business_license',
          requirement: '璇疯ˉ鍏呮竻鏅拌惀涓氭墽鐓?',
        }],
      },
    });
    const approveOther = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemIds[1]}/decision`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        decision: 'approve',
        comment: 'approve other policy',
      },
    });
    expect(supplement.statusCode).toBe(200);
    expect(supplement.json().data.application_status).toBe('need_supplement');
    expect(approveOther.statusCode).toBe(200);
    expect(approveOther.json().data.application_status).toBe('need_supplement');

    const rows = await getRows<{ app_status: string; item_statuses: string[] }>(
      `
        SELECT
          a.status::text AS app_status,
          array_agg(api.status::text ORDER BY api.item_id::text) AS item_statuses
        FROM applications a
        INNER JOIN application_policy_items api ON api.application_id = a.application_id
        WHERE a.application_id = $1
        GROUP BY a.application_id
      `,
      [submitted.applicationId],
    );
    expect(rows[0].app_status).toBe('need_supplement');
    expect(rows[0].item_statuses.sort()).toEqual(['approved', 'need_supplement']);
    await app.close();
  });

  it('submits supplement for a selected policy item and exposes supplement details', async () => {
    const app = await buildApp();
    const reviewerToken = await createTokenWithRole(app, 'reviewer', '13923000204');
    const submitted = await createMultiPolicyApplication(app);
    await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemIds[0]}/supplement-request`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        reason: 'need selected item material',
        deadline_at: '2026-06-14T18:00:00.000Z',
        required_materials: [{
          material_type: 'business_license',
          requirement: 'clear license',
        }],
        field_requirements: [{
          field_key: 'enterprise_profile.tax_amount',
          requirement: 'tax amount',
        }],
      },
    });
    const form = new FormData();
    form.set('enterprise_id', submitted.enterpriseId);
    form.set('file', new Blob(['supplement'], { type: 'text/plain' }), 'supplement.txt');
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { authorization: `Bearer ${submitted.token}` },
      payload: form,
    });
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${submitted.applicationId}/supplements`,
      headers: { authorization: `Bearer ${submitted.token}` },
      payload: {
        item_id: submitted.itemIds[0],
        materials: [{
          material_type: 'business_license',
          file_id: upload.json().data.file_id,
          mode: 'append',
        }],
      },
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${submitted.applicationId}`,
      headers: { authorization: `Bearer ${submitted.token}` },
    });

    expect(supplement.statusCode).toBe(200);
    expect(supplement.json().data.policy_item.item_id).toBe(submitted.itemIds[0]);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.supplements).toHaveLength(1);
    expect(detail.json().data.supplements[0]).toMatchObject({
      item_id: submitted.itemIds[0],
      reason: 'need selected item material',
      deadline_at: '2026-06-14T18:00:00.000Z',
    });
    expect(detail.json().data.supplements[0].required_materials).toHaveLength(1);
    expect(detail.json().data.supplements[0].field_requirements).toHaveLength(1);
    expect(detail.json().data.materials[0]).toMatchObject({
      item_id: submitted.itemIds[0],
      material_type: 'business_license',
    });
    await app.close();
  });

  it('keeps supplement deadlines and current materials isolated by policy item', async () => {
    const app = await buildApp();
    const reviewerToken = await createTokenWithRole(app, 'reviewer', '13923000214');
    const submitted = await createMultiPolicyApplication(app);

    for (const [index, itemId] of submitted.itemIds.entries()) {
      const request = await app.inject({
        method: 'POST',
        url: `/api/v1/review/tasks/${itemId}/supplement-request`,
        headers: { authorization: `Bearer ${reviewerToken}` },
        payload: {
          reason: `need item ${index}`,
          deadline_at: index === 0
            ? '2026-06-14T18:00:00.000Z'
            : '2026-06-20T09:30:00.000Z',
          required_materials: [{ material_type: 'business_license' }],
        },
      });
      expect(request.statusCode).toBe(200);
    }

    for (const [index, itemId] of submitted.itemIds.entries()) {
      const form = new FormData();
      form.set('enterprise_id', submitted.enterpriseId);
      form.set('file', new Blob([`supplement-${index}`], { type: 'text/plain' }), `supplement-${index}.txt`);
      const upload = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { authorization: `Bearer ${submitted.token}` },
        payload: form,
      });
      expect(upload.statusCode).toBe(200);

      const supplement = await app.inject({
        method: 'POST',
        url: `/api/v1/applications/${submitted.applicationId}/supplements`,
        headers: { authorization: `Bearer ${submitted.token}` },
        payload: {
          item_id: itemId,
          materials: [{
            material_type: 'business_license',
            file_id: upload.json().data.file_id,
            mode: 'append',
          }],
        },
      });
      expect(supplement.statusCode).toBe(200);
    }

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${submitted.applicationId}`,
      headers: { authorization: `Bearer ${submitted.token}` },
    });

    expect(detail.statusCode).toBe(200);
    const supplements = detail.json().data.supplements as Array<{
      item_id: string;
      deadline_at: string;
    }>;
    expect(supplements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        item_id: submitted.itemIds[0],
        deadline_at: '2026-06-14T18:00:00.000Z',
      }),
      expect.objectContaining({
        item_id: submitted.itemIds[1],
        deadline_at: '2026-06-20T09:30:00.000Z',
      }),
    ]));
    const currentMaterials = await getRows<{ item_id: string; total: string }>(
      `
        SELECT policy_item_id::text AS item_id, COUNT(*)::text AS total
        FROM materials
        WHERE application_id = $1
          AND material_type = 'business_license'
          AND is_current = true
        GROUP BY policy_item_id
      `,
      [submitted.applicationId],
    );
    expect(currentMaterials).toHaveLength(2);
    expect(currentMaterials.map((row) => row.item_id).sort())
      .toEqual([...submitted.itemIds].sort());
    await app.close();
  });

  it('lists applications by parent application with aggregated policy_items', async () => {
    const app = await buildApp();
    const submitted = await createMultiPolicyApplication(app);
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/applications?enterprise_id=${submitted.enterpriseId}&page=1&page_size=20`,
      headers: { authorization: `Bearer ${submitted.token}` },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().data.total).toBe(1);
    expect(list.json().data.items).toHaveLength(1);
    expect(list.json().data.items[0].policy_items).toHaveLength(2);
    await app.close();
  });

  it('uses application evidence for batch eligibility policy_ids', async () => {
    const app = await buildApp();
    const enterprise = await createEnterpriseOwner(app, {
      phone: '13923000205',
      enterpriseName: 'Batch23 Eligibility Enterprise',
      creditCode: '913607BT0000230205',
    });
    await app.inject({
      method: 'PUT',
      url: '/api/v1/enterprise-profile',
      headers: { authorization: `Bearer ${enterprise.token}` },
      payload: {
        enterprise_id: enterprise.enterpriseId,
        enterprise_name: 'Batch23 Eligibility Enterprise',
        credit_code: '913607BT0000230205',
        industry: 'furniture',
      },
    });
    const policyA = await createEffectiveWhitelistedPolicyWithCreditCondition(
      'Batch23 Eligibility A',
      '913607BT0000230205',
    );
    const policyB = await createEffectiveWhitelistedPolicyWithCreditCondition(
      'Batch23 Eligibility B',
      '913607BT0000230205',
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${enterprise.token}` },
      payload: {
        enterprise_id: enterprise.enterpriseId,
        policy_ids: [policyA, policyB],
      },
    });
    const applicationId = created.json().data.application_id as string;
    const itemIds = created.json().data.policy_items.map(
      (item: { item_id: string }) => item.item_id,
    ) as string[];
    const file = await getRows<{ file_id: string }>(
      `
        INSERT INTO files (
          enterprise_id,
          uploader_user_id,
          original_filename,
          mime_type,
          byte_size,
          file_hash,
          storage_key,
          purpose
        )
        VALUES ($1, $2, 'ocr.txt', 'text/plain', 3, 'hash-eligibility', 'ocr-key', 'enterprise_resource')
        RETURNING file_id::text
      `,
      [enterprise.enterpriseId, enterprise.userId],
    );
    for (const itemId of itemIds) {
      const material = await getRows<{ material_id: string }>(
        `
          INSERT INTO materials (
            application_id,
            policy_item_id,
            material_type,
            file_id,
            file_hash
          )
          VALUES ($1, $2, 'business_license', $3, 'hash-eligibility')
          RETURNING material_id::text
        `,
        [applicationId, itemId, file[0].file_id],
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
            '{"credit_code":"913607BT0000230205"}'::jsonb,
            '{"credit_code":0.95}'::jsonb,
            0.95,
            '[]'::jsonb,
            false
          )
        `,
        [material[0].material_id],
      );
    }
    const eligibility = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${enterprise.token}` },
      payload: {
        enterprise_id: enterprise.enterpriseId,
        application_id: applicationId,
        policy_ids: [policyA, policyB],
      },
    });

    expect(eligibility.statusCode).toBe(200);
    expect(eligibility.json().data.results).toHaveLength(2);
    expect(eligibility.json().data.results.map((item: { result: string }) => item.result))
      .toEqual(['eligible', 'eligible']);
    await app.close();
  });

  it('validates supplement-request body and deadline', async () => {
    const app = await buildApp();
    const reviewerToken = await createTokenWithRole(app, 'reviewer', '13923000206');
    const submitted = await createMultiPolicyApplication(app);
    const emptyBody = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemIds[0]}/supplement-request`,
      headers: { authorization: `Bearer ${reviewerToken}` },
    });
    const badDeadline = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemIds[0]}/supplement-request`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        reason: 'bad deadline',
        deadline_at: 'not-a-date',
        required_materials: [{ material_type: 'business_license' }],
      },
    });
    const badArrays = await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemIds[0]}/supplement-request`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        reason: 'bad arrays',
        required_materials: { material_type: 'business_license' },
      },
    });

    expect(emptyBody.statusCode).toBe(400);
    expect(badDeadline.statusCode).toBe(400);
    expect(badArrays.statusCode).toBe(400);
    await app.close();
  });

  it('rejects enterprise_binding files when submitting supplement materials', async () => {
    const app = await buildApp();
    const reviewerToken = await createTokenWithRole(app, 'reviewer', '13923000215');
    const submitted = await createMultiPolicyApplication(app);
    await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${submitted.itemIds[0]}/supplement-request`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        reason: 'need resource file',
        required_materials: [{ material_type: 'business_license' }],
      },
    });
    const fileId = await uploadBindingFile(app, submitted.token);
    await getRows(
      `
        UPDATE files
        SET enterprise_id = $2
        WHERE file_id = $1
      `,
      [fileId, submitted.enterpriseId],
    );

    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${submitted.applicationId}/supplements`,
      headers: { authorization: `Bearer ${submitted.token}` },
      payload: {
        item_id: submitted.itemIds[0],
        materials: [{
          material_type: 'business_license',
          file_id: fileId,
          mode: 'append',
        }],
      },
    });

    expect(supplement.statusCode).toBe(400);
    await app.close();
  });

  it('validates admin profile import body and row values', async () => {
    const app = await buildApp();
    const adminToken = await createTokenWithRole(
      app,
      'system_admin',
      '13923000207',
      'admin',
    );
    const emptyBody = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/enterprise-profiles/import',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const badRows = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/enterprise-profiles/import',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        rows: [
          null,
          {
            enterprise_name: 'Bad Number Enterprise',
            credit_code: '913607BT0000230207',
            revenue_amount: 'bad',
          },
          {
            enterprise_name: 'Bad Employee Count Enterprise',
            credit_code: '913607BT0000230217',
            employee_count: 1.5,
          },
        ],
      },
    });

    expect(emptyBody.statusCode).toBe(400);
    expect(badRows.statusCode).toBe(200);
    expect(badRows.json().data.failed).toBe(3);
    expect(badRows.json().data.inserted).toBe(0);
    await app.close();
  });

  it('withdraws submitted applications and policy items', async () => {
    const app = await buildApp();
    const submitted = await createMultiPolicyApplication(app);

    const withdrawn = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${submitted.applicationId}/withdraw`,
      headers: { authorization: `Bearer ${submitted.token}` },
      payload: {
        idempotency_key: 'batch23_withdraw',
        comment: '企业主动撤回',
      },
    });

    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().data.status).toBe('withdrawn');
    const rows = await getRows<{ app_status: string; item_statuses: string[] }>(
      `
        SELECT
          a.status::text AS app_status,
          array_agg(api.status::text ORDER BY api.item_id::text) AS item_statuses
        FROM applications a
        INNER JOIN application_policy_items api ON api.application_id = a.application_id
        WHERE a.application_id = $1
        GROUP BY a.application_id
      `,
      [submitted.applicationId],
    );
    expect(rows[0].app_status).toBe('withdrawn');
    expect(rows[0].item_statuses).toEqual(['withdrawn', 'withdrawn']);
    await app.close();
  });
});
