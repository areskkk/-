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
    name: 'Batch15 Reviewer',
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

async function createEffectivePolicy(title = 'Batch15 Policy') {
  const rows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, status, version, content)
      VALUES ($1, 'manual_import', 'effective', 'v1', 'batch15 policy content')
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

  const reviewerToken = await createReviewerToken(app, `13${input.phone.slice(2, 11)}5`);
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
  };
}

describeIfDb('batch15 OCR evidence presentation', () => {
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

  it('shows enterprise OCR summary for current material only and highlights low confidence', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910001501',
      enterpriseName: 'Batch15 Enterprise OCR Summary',
      creditCode: '913607FF0000011501',
    });

    const firstUpload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'business-license-success.json',
      buildBusinessLicenseSuccessFixture(),
    );
    const firstSupplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'business_license',
            file_id: firstUpload.json().data.file_id,
            mode: 'append',
          },
        ],
      },
    });
    const firstMaterialId = firstSupplement.json().data.materials[0].material_id;
    await app.inject({
      method: 'POST',
      url: `/api/v1/materials/${firstMaterialId}/ocr`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {},
    });

    await getRows(
      "UPDATE applications SET status = 'need_supplement' WHERE application_id = $1",
      [context.applicationId],
    );
    await getRows(
      "UPDATE application_policy_items SET status = 'need_supplement' WHERE application_id = $1",
      [context.applicationId],
    );

    const secondUpload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'business-license-low-confidence.json',
      buildBusinessLicenseLowConfidenceFixture(),
    );
    const secondSupplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'business_license',
            file_id: secondUpload.json().data.file_id,
            mode: 'replace',
          },
        ],
      },
    });
    const secondMaterialId = secondSupplement.json().data.materials[0].material_id;
    await app.inject({
      method: 'POST',
      url: `/api/v1/materials/${secondMaterialId}/ocr`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {},
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${context.applicationId}`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.materials).toHaveLength(1);
    expect(detail.json().data.materials[0].material_id).toBe(secondMaterialId);
    expect(detail.json().data.materials[0].ocr_summary).toMatchObject({
      status: 'low_confidence',
      requires_manual_confirmation: true,
      display_message: '存在需人工确认的 OCR 字段，当前结果不能直接作为硬证据',
    });
    expect(detail.json().data.materials[0].ocr_summary.low_confidence_fields[0]).toMatchObject({
      field_key: 'credit_code',
      field_label: '统一社会信用代码',
      confidence: 0.82,
    });
    expect(detail.json().data.materials[0].ocr_summary.overall_risk).toMatchObject({
      is_low_confidence: true,
      confidence: 0.82,
    });
    await app.close();
  });

  it('returns stable enterprise OCR summary for pending and failed states', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910001502',
      enterpriseName: 'Batch15 Enterprise OCR States',
      creditCode: '913607FF0000011502',
    });

    const pendingUpload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'pending-business-license.json',
      buildBusinessLicenseSuccessFixture(),
    );
    const pendingSupplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'business_license',
            file_id: pendingUpload.json().data.file_id,
            mode: 'append',
          },
        ],
      },
    });
    const pendingMaterialId = pendingSupplement.json().data.materials[0].material_id;

    const pendingDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${context.applicationId}`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
    });
    expect(pendingDetail.json().data.materials[0].material_id).toBe(pendingMaterialId);
    expect(pendingDetail.json().data.materials[0].ocr_summary).toEqual({
      status: 'pending',
      display_message: '尚未识别',
      requires_manual_confirmation: false,
      overall_confidence: null,
      warnings: [],
      recognized_fields_summary: [],
      low_confidence_fields: [],
      overall_risk: null,
    });

    await getRows(
      "UPDATE applications SET status = 'need_supplement' WHERE application_id = $1",
      [context.applicationId],
    );
    await getRows(
      "UPDATE application_policy_items SET status = 'need_supplement' WHERE application_id = $1",
      [context.applicationId],
    );

    const failedUpload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'failed-business-license.json',
      'invalid-json-fixture',
    );
    const failedSupplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'business_license',
            file_id: failedUpload.json().data.file_id,
            mode: 'replace',
          },
        ],
      },
    });
    const failedMaterialId = failedSupplement.json().data.materials[0].material_id;
    await app.inject({
      method: 'POST',
      url: `/api/v1/materials/${failedMaterialId}/ocr`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {},
    });

    const failedDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${context.applicationId}`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
    });
    expect(failedDetail.json().data.materials[0].material_id).toBe(failedMaterialId);
    expect(failedDetail.json().data.materials[0].ocr_summary).toEqual({
      status: 'failed',
      display_message: 'OCR 识别失败，请重新上传更清晰材料或联系人工处理',
      requires_manual_confirmation: false,
      overall_confidence: null,
      warnings: [],
      recognized_fields_summary: [],
      low_confidence_fields: [],
      overall_risk: null,
    });
    await app.close();
  });

  it('shows normalized OCR evidence for government review detail without raw provider noise', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910001503',
      enterpriseName: 'Batch15 Government OCR Evidence',
      creditCode: '913607FF0000011503',
    });

    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'review-business-license-low-confidence.json',
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
    await app.inject({
      method: 'POST',
      url: `/api/v1/materials/${materialId}/ocr`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {},
    });

    const reviewerToken = await createReviewerToken(app, '13910001599');
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/review/tasks/${context.itemId}`,
      headers: { authorization: `Bearer ${reviewerToken}` },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.materials).toHaveLength(1);
    expect(detail.json().data.materials[0].material_id).toBe(materialId);
    expect(detail.json().data.materials[0].ocr_evidence).toMatchObject({
      status: 'low_confidence',
      requires_manual_confirmation: true,
      overall_confidence: 0.82,
      evidence_notice:
        'OCR 结果仅作证据参考；低置信度字段不得直接作为硬证据通过，最终审核结论仍由人工确认。',
    });
    expect(detail.json().data.materials[0].ocr_evidence.low_confidence_fields[0]).toMatchObject({
      field_key: 'credit_code',
      field_label: '统一社会信用代码',
      confidence: 0.82,
    });
    expect(detail.json().data.materials[0].ocr_evidence.raw_provider_meta).toBeUndefined();
    await app.close();
  });
});
