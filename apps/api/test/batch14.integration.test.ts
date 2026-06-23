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
import {
  buildBusinessLicenseLowConfidenceFixture,
  buildBusinessLicenseSuccessFixture,
} from './ocr-fixture-utils.js';

process.env.FILE_STORAGE_ROOT = '.tmp/test-uploads';
process.env.FILE_UPLOAD_MAX_BYTES = '1024';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;
const sidecar = new OcrSidecarTestManager();

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

async function createReviewerToken(app: TestApp, phone: string) {
  const { userId } = await registerAndLogin(app, {
    name: 'Batch14 Reviewer',
    phone,
    password: 'secret123',
    user_type: 'government',
  });
  await assignRole(userId, 'reviewer');
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

async function createEffectivePolicy(title = 'Batch14 Policy') {
  const rows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, status, version, content)
      VALUES ($1, 'manual_import', 'effective', 'v1', 'batch14 policy content')
      RETURNING policy_id
    `,
    [title],
  );
  return rows[0].policy_id;
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
  form.set('file', new Blob([content], { type: 'application/json' }), filename);
  return app.inject({
    method: 'POST',
    url: '/api/v1/files',
    headers: { authorization: `Bearer ${token}` },
    payload: form,
  });
}

async function createNeedSupplementApplication(app: TestApp, input: {
  phone: string;
  enterpriseName: string;
  creditCode: string;
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
      employee_count: 26,
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

  await app.inject({
    method: 'POST',
    url: `/api/v1/applications/${applicationId}/submit`,
    headers: { authorization: `Bearer ${enterpriseToken}` },
  });

  const reviewerToken = await createReviewerToken(app, `13${input.phone.slice(2, 11)}4`);
  await app.inject({
    method: 'POST',
    url: `/api/v1/review/tasks/${itemId}/decision`,
    headers: { authorization: `Bearer ${reviewerToken}` },
    payload: {
      decision: 'request_supplement',
      comment: '请补充营业执照清晰扫描件',
    },
  });

  return {
    enterpriseToken,
    enterpriseId,
    applicationId,
    itemId,
    policyId,
  };
}

describeIfDb('batch14 OCR real integration', () => {
  beforeAll(async () => {
    process.env.OCR_SERVICE_BASE_URL = sidecar.baseUrl;
    process.env.OCR_SERVICE_TIMEOUT_MS = '15000';
    await prepareDatabase();
    await sidecar.setupSuite();
  }, 240000);

  beforeEach(async () => {
    await truncateBusinessTables();
    await clearConfiguredTestUploadDir();
  });

  afterAll(async () => {
    await clearConfiguredTestUploadDir();
    await sidecar.teardownSuite();
  }, 30000);

  it('runs real OCR for business_license success and writes OCR facts', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910001401',
      enterpriseName: 'Batch14 OCR Success',
      creditCode: '913607FF0000011401',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'business-license-success.json',
      buildBusinessLicenseSuccessFixture(),
    );

    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
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
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {},
    });
    const latest = await app.inject({
      method: 'GET',
      url: `/api/v1/materials/${materialId}/ocr`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
    });

    expect(ocr.statusCode).toBe(200);
    expect(ocr.json().data.requires_manual_confirmation).toBe(false);
    expect(ocr.json().data.material_type).toBe('business_license');
    expect(latest.statusCode).toBe(200);
    expect(latest.json().data.fields.enterprise_name).toBe('南康某家具有限公司');

    const rows = await getRows<{ ocr_status: string; total: string }>(
      `
        SELECT
          m.ocr_status::text,
          (SELECT COUNT(*)::text FROM ocr_results WHERE material_id = m.material_id) AS total
        FROM materials m
        WHERE m.material_id = $1
      `,
      [materialId],
    );
    expect(rows[0]).toEqual({
      ocr_status: 'success',
      total: '1',
    });
    await app.close();
  });

  it('marks low confidence OCR as manual confirmation required and keeps it out of hard evidence pass', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910001402',
      enterpriseName: 'Batch14 OCR Low',
      creditCode: '913607FF0000011402',
    });
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
        VALUES ($1, 'ocr.business_license.credit_code', 'eq', '\"913607XX0000000000\"'::jsonb, true, 'ocr', 'eligible')
      `,
      [context.policyId],
    );
    await getRows(
      'INSERT INTO policy_ai_whitelist (policy_id, enabled) VALUES ($1, true) ON CONFLICT (policy_id) DO UPDATE SET enabled = true',
      [context.policyId],
    );
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'business-license-low-confidence.json',
      buildBusinessLicenseLowConfidenceFixture(),
    );
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
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
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {},
    });

    const eligibility = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_id: context.policyId,
        application_id: context.applicationId,
      },
    });

    expect(ocr.statusCode).toBe(200);
    expect(ocr.json().data.requires_manual_confirmation).toBe(true);
    expect(ocr.json().data.ocr_status).toBe('low_confidence');
    expect(eligibility.statusCode).toBe(200);
    expect(eligibility.json().data.result).not.toBe('eligible');

    const rows = await getRows<{
      ocr_status: string;
      requires_manual_confirmation: boolean;
    }>(
      `
        SELECT
          m.ocr_status::text,
          o.requires_manual_confirmation
        FROM materials m
        INNER JOIN ocr_results o ON o.material_id = m.material_id
        WHERE m.material_id = $1
      `,
      [materialId],
    );
    expect(rows[0]).toEqual({
      ocr_status: 'low_confidence',
      requires_manual_confirmation: true,
    });
    await app.close();
  });

  it('fails clearly and writes failed status when OCR provider cannot parse the material', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910001403',
      enterpriseName: 'Batch14 OCR Failure',
      creditCode: '913607FF0000011403',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'business-license-invalid.json',
      'not-a-valid-json-fixture',
    );
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
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
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {},
    });

    expect(ocr.statusCode).toBe(500);

    const rows = await getRows<{ ocr_status: string; total: string }>(
      `
        SELECT
          m.ocr_status::text,
          (SELECT COUNT(*)::text FROM ocr_results WHERE material_id = m.material_id) AS total
        FROM materials m
        WHERE m.material_id = $1
      `,
      [materialId],
    );
    expect(rows[0]).toEqual({
      ocr_status: 'failed',
      total: '0',
    });
    await app.close();
  });
});
