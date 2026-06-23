import fs from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { localFileStorageService } from '../src/modules/files/storage.service.js';
import { ocrJobWorker } from '../src/modules/ocr/ocr-job-worker.js';
import { claimNextOcrJob } from '../src/modules/ocr/ocr-job.repository.js';
import { ocrService } from '../src/modules/ocr/ocr.service.js';
import { setOcrProviderForTest } from '../src/modules/ocr/providers/ocr-provider.factory.js';
import { type OcrProvider } from '../src/modules/ocr/providers/ocr-provider.js';
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
const ocrSidecar = new OcrSidecarTestManager();

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

async function createReviewerToken(app: TestApp, phone: string) {
  const { userId } = await registerAndLogin(app, {
    name: 'Batch6 Reviewer',
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

async function createEffectivePolicy(title = 'Batch6 Policy') {
  const rows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, status, version, content)
      VALUES ($1, 'manual_import', 'effective', 'v1', 'batch6 policy content')
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
  form.set('file', new Blob([content], { type: 'text/plain' }), filename);
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
  initialMaterial?: boolean;
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

  if (input.initialMaterial) {
    const upload = await uploadFile(
      app,
      enterpriseToken,
      enterpriseId,
      'old-license.txt',
      'old license',
    );
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

  const reviewerToken = await createReviewerToken(app, `13${input.phone.slice(2, 11)}9`);
  await app.inject({
    method: 'POST',
    url: `/api/v1/review/tasks/${itemId}/decision`,
    headers: { authorization: `Bearer ${reviewerToken}` },
    payload: {
      decision: 'request_supplement',
      comment: '璇疯ˉ鍏呰惀涓氭墽鐓ф竻鏅版壂鎻忎欢',
    },
  });

  return {
    enterpriseToken,
    enterpriseId,
    applicationId,
    itemId,
  };
}

describeIfDb('batch6 integration', () => {
  beforeAll(async () => {
    process.env.OCR_SERVICE_BASE_URL = ocrSidecar.baseUrl;
    process.env.OCR_SERVICE_TIMEOUT_MS = '15000';
    await prepareDatabase();
    await ocrSidecar.setupSuite();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    await clearConfiguredTestUploadDir();
    setOcrProviderForTest(null);
  });

  afterEach(() => {
    setOcrProviderForTest(null);
  });

  afterAll(async () => {
    await clearConfiguredTestUploadDir();
    await ocrSidecar.teardownSuite();
  });

  it('shows latest supplement reason in enterprise application detail', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000601',
      enterpriseName: 'Supplement Reason Enterprise',
      creditCode: '913607FF0000000601',
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${context.applicationId}`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.status).toBe('need_supplement');
    expect(detail.json().data.supplement.reason).toBe('璇疯ˉ鍏呰惀涓氭墽鐓ф竻鏅版壂鎻忎欢');
    expect(detail.json().data.supplement.item_id).toBe(context.itemId);
    await app.close();
  });

  it('submits supplement append and moves single-policy application to resubmitted', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000602',
      enterpriseName: 'Append Supplement Enterprise',
      creditCode: '913607FF0000000602',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'license-new.txt',
      'new license',
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
        comment: 'supplemented materials',
      },
    });

    expect(supplement.statusCode).toBe(200);
    expect(supplement.json().data.status).toBe('resubmitted');
    expect(supplement.json().data.policy_item).toMatchObject({
      item_id: context.itemId,
      status: 'resubmitted',
      review_result: null,
    });

    const rows = await getRows<{
      application_status: string;
      item_status: string;
      review_result: string | null;
      current_count: string;
    }>(
      `
        SELECT
          a.status::text AS application_status,
          api.status::text AS item_status,
          api.review_result,
          (
            SELECT COUNT(*)::text
            FROM materials
            WHERE application_id = a.application_id
              AND material_type = 'business_license'
              AND is_current = true
          ) AS current_count
        FROM applications a
        INNER JOIN application_policy_items api ON api.application_id = a.application_id
        WHERE a.application_id = $1
      `,
      [context.applicationId],
    );
    const audits = await getRows<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'application.supplement.submit'",
    );
    expect(rows[0]).toEqual({
      application_status: 'resubmitted',
      item_status: 'resubmitted',
      review_result: null,
      current_count: '1',
    });
    expect(audits).toHaveLength(1);
    await app.close();
  });

  it('replaces current material and makes old material non-current', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000603',
      enterpriseName: 'Replace Supplement Enterprise',
      creditCode: '913607FF0000000603',
      initialMaterial: true,
    });
    const oldMaterial = await getRows<{ material_id: string }>(
      `
        SELECT material_id::text
        FROM materials
        WHERE application_id = $1
          AND material_type = 'business_license'
          AND is_current = true
      `,
      [context.applicationId],
    );
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'replacement-license.txt',
      'replacement license',
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
            mode: 'replace',
          },
        ],
      },
    });

    expect(supplement.statusCode).toBe(200);

    const materials = await getRows<{
      material_id: string;
      is_current: boolean;
      replaced_by_material_id: string | null;
      superseded_at: string | null;
    }>(
      `
        SELECT
          material_id::text,
          is_current,
          replaced_by_material_id::text,
          superseded_at::text
        FROM materials
        WHERE application_id = $1
          AND material_type = 'business_license'
        ORDER BY created_at ASC
      `,
      [context.applicationId],
    );
    const current = materials.filter((material) => material.is_current);
    const old = materials.find((material) => material.material_id === oldMaterial[0].material_id);

    expect(materials).toHaveLength(2);
    expect(current).toHaveLength(1);
    expect(old?.is_current).toBe(false);
    expect(old?.replaced_by_material_id).toBe(current[0].material_id);
    expect(old?.superseded_at).toBeTruthy();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${context.applicationId}`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
    });
    expect(detail.json().data.materials).toHaveLength(1);
    expect(detail.json().data.materials[0].material_id).toBe(current[0].material_id);
    await app.close();
  });

  it('shows only the latest supplement reason for the current single policy item', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000613',
      enterpriseName: 'Latest Supplement Reason Enterprise',
      creditCode: '913607FF0000000613',
    });
    const reviewerToken = await createReviewerToken(app, '13910001613');

    await getRows(
      `
        UPDATE application_policy_items
        SET status = 'reviewing'
        WHERE item_id = $1
      `,
      [context.itemId],
    );
    await app.inject({
      method: 'POST',
      url: `/api/v1/review/tasks/${context.itemId}/decision`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        decision: 'request_supplement',
        comment: '璇烽噸鏂颁笂浼犲姞鐩栧叕绔犵殑钀ヤ笟鎵х収',
      },
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${context.applicationId}`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.supplement).toMatchObject({
      item_id: context.itemId,
      reason: '璇烽噸鏂颁笂浼犲姞鐩栧叕绔犵殑钀ヤ笟鎵х収',
    });
    await app.close();
  });

  it('rejects replace when no current material exists for the material type', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000611',
      enterpriseName: 'Replace Missing Current Enterprise',
      creditCode: '913607FF0000000611',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'missing-current-license.txt',
      'missing current license',
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
            mode: 'replace',
          },
        ],
      },
    });

    expect(supplement.statusCode).toBe(409);
    expect(supplement.json().error.message).toContain(
      'replace requires exactly one current material',
    );
    await app.close();
  });

  it('rejects supplement submit for non-need-supplement application and cross-enterprise file', async () => {
    const app = await buildApp();
    const userA = await registerAndLogin(app, {
      name: 'Supplement Boundary A',
      phone: '13910000604',
      password: 'secret123',
    });
    const userB = await registerAndLogin(app, {
      name: 'Supplement Boundary B',
      phone: '13910000605',
      password: 'secret123',
    });
    const enterpriseA = await bindEnterprise(app, userA.token, {
      enterprise_name: 'Supplement Boundary A',
      credit_code: '913607FF0000000604',
    });
    const enterpriseB = await bindEnterprise(app, userB.token, {
      enterprise_name: 'Supplement Boundary B',
      credit_code: '913607FF0000000605',
    });
    const policyId = await createEffectivePolicy('Boundary Policy');
    const draft = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        enterprise_id: enterpriseA,
        policy_id: policyId,
      },
    });
    const uploadB = await uploadFile(app, userB.token, enterpriseB, 'b.txt', 'b file');

    const nonNeedSupplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${draft.json().data.application_id}/supplements`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        materials: [
          {
            material_type: 'business_license',
            file_id: uploadB.json().data.file_id,
            mode: 'append',
          },
        ],
      },
    });

    const context = await createNeedSupplementApplication(app, {
      phone: '13910000606',
      enterpriseName: 'Supplement Boundary C',
      creditCode: '913607FF0000000606',
    });
    const crossFile = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'business_license',
            file_id: uploadB.json().data.file_id,
            mode: 'append',
          },
        ],
      },
    });

    expect(nonNeedSupplement.statusCode).toBe(409);
    expect(crossFile.statusCode).toBe(403);
    await app.close();
  });

  it('runs business_license OCR success and stores result', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000607',
      enterpriseName: 'Ocr Success Enterprise',
      creditCode: '913607FF0000000607',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'ocr-license-success.json',
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
    expect(ocr.json().data.material_type).toBe('business_license');
    expect(ocr.json().data.requires_manual_confirmation).toBe(false);
    expect(latest.statusCode).toBe(200);
    expect(latest.json().data.fields.enterprise_name).toBeTruthy();

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
    expect(rows[0]).toEqual({ ocr_status: 'success', total: '1' });
    await app.close();
  });

  it('runs OCR for financial_report through the generic material pipeline', async () => {
    const provider: OcrProvider = {
      async analyze() {
        return {
          material_type: 'financial_report',
          fields: {
            enterprise_name: 'Financial OCR Enterprise',
            report_year: 2025,
            revenue_amount: 12000000,
          },
          field_confidence: {
            enterprise_name: 0.93,
            report_year: 0.91,
            revenue_amount: 0.9,
          },
          overall_confidence: 0.91,
          warnings: [],
          raw_provider_meta: { provider: 'test-generic-ocr' },
        };
      },
    };
    setOcrProviderForTest(provider);
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000613',
      enterpriseName: 'Financial OCR Enterprise',
      creditCode: '913607FF0000000613',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'financial-report.txt',
      'report_year:2025\nrevenue_amount:12000000',
    );
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'financial_report',
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

    expect(ocr.statusCode).toBe(200);
    expect(ocr.json().data.material_type).toBe('financial_report');
    expect(ocr.json().data.fields.revenue_amount).toBe(12000000);
    expect(ocr.json().data.ocr_status).toBe('success');
    await app.close();
  });

  it('queues OCR and lets the worker persist the provider result asynchronously', async () => {
    const provider: OcrProvider = {
      async analyze() {
        return {
          material_type: 'employment_proof',
          fields: {
            enterprise_name: 'Async OCR Enterprise',
            employee_count: 42,
          },
          field_confidence: {
            enterprise_name: 0.94,
            employee_count: 0.92,
          },
          overall_confidence: 0.93,
          warnings: [],
          raw_provider_meta: { provider: 'test-async-ocr' },
        };
      },
    };
    setOcrProviderForTest(provider);
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000614',
      enterpriseName: 'Async OCR Enterprise',
      creditCode: '913607FF0000000614',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'employment-proof.txt',
      'employee_count:42',
    );
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'employment_proof',
            file_id: upload.json().data.file_id,
            mode: 'append',
          },
        ],
      },
    });
    const materialId = supplement.json().data.materials[0].material_id;

    const queued = await app.inject({
      method: 'POST',
      url: `/api/v1/materials/${materialId}/ocr`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: { mode: 'async' },
    });

    expect(queued.statusCode).toBe(200);
    expect(queued.json().data).toMatchObject({
      material_id: materialId,
      material_type: 'employment_proof',
      ocr_status: 'pending',
      async_status: 'queued',
      created: true,
    });

    expect(await ocrJobWorker.drainOnce(1)).toBe(1);
    const rows = await getRows<{
      job_status: string;
      material_status: string;
      employee_count: number;
    }>(
      `
        SELECT
          j.status AS job_status,
          m.ocr_status::text AS material_status,
          (o.fields->>'employee_count')::int AS employee_count
        FROM ocr_jobs j
        INNER JOIN materials m ON m.material_id = j.material_id
        INNER JOIN ocr_results o ON o.material_id = m.material_id
        WHERE j.material_id = $1
      `,
      [materialId],
    );
    expect(rows[0]).toEqual({
      job_status: 'completed',
      material_status: 'success',
      employee_count: 42,
    });
    await app.close();
  });

  it('keeps material pending after a retryable async OCR failure and succeeds on retry', async () => {
    let calls = 0;
    setOcrProviderForTest({
      async analyze() {
        calls += 1;
        if (calls === 1) {
          throw new Error('temporary OCR provider failure');
        }
        return {
          material_type: 'employment_proof',
          fields: { enterprise_name: 'Retry OCR Enterprise', employee_count: 9 },
          field_confidence: { enterprise_name: 0.95, employee_count: 0.95 },
          overall_confidence: 0.95,
          warnings: [],
        };
      },
    });
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000619',
      enterpriseName: 'Retry OCR Enterprise',
      creditCode: '913607FF0000000619',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'retry-ocr.txt',
      'employee_count:9',
    );
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'employment_proof',
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
      payload: { mode: 'async' },
    });

    expect(await ocrJobWorker.drainOnce(1)).toBe(1);
    const afterFailure = await getRows<{
      material_status: string;
      job_status: string;
      audit_count: string;
    }>(
      `
        SELECT
          m.ocr_status::text AS material_status,
          j.status AS job_status,
          (
            SELECT COUNT(*)::text
            FROM audit_logs
            WHERE action = 'material.ocr.analyze_failed'
              AND target_id = m.material_id::text
          ) AS audit_count
        FROM materials m
        INNER JOIN ocr_jobs j ON j.material_id = m.material_id
        WHERE m.material_id = $1
      `,
      [materialId],
    );
    expect(afterFailure[0]).toEqual({
      material_status: 'pending',
      job_status: 'queued',
      audit_count: '0',
    });

    await getRows('UPDATE ocr_jobs SET available_at = now() WHERE material_id = $1', [materialId]);
    expect(await ocrJobWorker.drainOnce(1)).toBe(1);
    const afterRetry = await getRows<{
      material_status: string;
      job_status: string;
      audit_count: string;
      employee_count: number;
    }>(
      `
        SELECT
          m.ocr_status::text AS material_status,
          j.status AS job_status,
          (r.fields->>'employee_count')::int AS employee_count,
          (
            SELECT COUNT(*)::text
            FROM audit_logs
            WHERE action = 'material.ocr.analyze_failed'
              AND target_id = m.material_id::text
          ) AS audit_count
        FROM materials m
        INNER JOIN ocr_jobs j ON j.material_id = m.material_id
        INNER JOIN ocr_results r ON r.material_id = m.material_id
        WHERE m.material_id = $1
      `,
      [materialId],
    );
    expect(afterRetry[0]).toEqual({
      material_status: 'success',
      job_status: 'completed',
      audit_count: '0',
      employee_count: 9,
    });
    expect(calls).toBe(2);
    await app.close();
  });

  it('marks material failed when sync OCR result persistence is interrupted after provider success', async () => {
    setOcrProviderForTest({
      async analyze() {
        return {
          material_type: 'employment_proof',
          fields: { enterprise_name: 'Sync Failure OCR Enterprise', employee_count: 11 },
          field_confidence: { enterprise_name: 0.95, employee_count: 0.95 },
          overall_confidence: 0.95,
          warnings: [],
        };
      },
    });
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000621',
      enterpriseName: 'Sync Failure OCR Enterprise',
      creditCode: '913607FF0000000621',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'sync-failure-ocr.txt',
      'employee_count:11',
    );
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'employment_proof',
            file_id: upload.json().data.file_id,
            mode: 'append',
          },
        ],
      },
    });
    const materialId = supplement.json().data.materials[0].material_id;
    await getRows(
      `
        CREATE OR REPLACE FUNCTION test_block_ocr_success_audit()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.action = 'material.ocr.analyze' THEN
            RAISE EXCEPTION 'forced success audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_ocr_success_audit_trigger
        BEFORE INSERT ON audit_logs
        FOR EACH ROW
        EXECUTE FUNCTION test_block_ocr_success_audit();
      `,
    );

    try {
      const ocr = await app.inject({
        method: 'POST',
        url: `/api/v1/materials/${materialId}/ocr`,
        headers: { authorization: `Bearer ${context.enterpriseToken}` },
        payload: { mode: 'provider' },
      });

      expect(ocr.statusCode).toBe(500);
    } finally {
      await getRows(`
        DROP TRIGGER IF EXISTS test_block_ocr_success_audit_trigger ON audit_logs;
        DROP FUNCTION IF EXISTS test_block_ocr_success_audit();
      `);
    }

    const rows = await getRows<{
      material_status: string;
      failed_audit_count: string;
      success_result_count: string;
    }>(
      `
        SELECT
          m.ocr_status::text AS material_status,
          (
            SELECT COUNT(*)::text
            FROM audit_logs
            WHERE action = 'material.ocr.analyze_failed'
              AND target_id = m.material_id::text
          ) AS failed_audit_count,
          (
            SELECT COUNT(*)::text
            FROM ocr_results
            WHERE material_id = m.material_id
          ) AS success_result_count
        FROM materials m
        WHERE m.material_id = $1
      `,
      [materialId],
    );
    expect(rows[0]).toEqual({
      material_status: 'failed',
      failed_audit_count: '1',
      success_result_count: '1',
    });
    await app.close();
  });

  it('retries stale OCR jobs by incrementing attempts and fails after max attempts', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000615',
      enterpriseName: 'Stale OCR Enterprise',
      creditCode: '913607FF0000000615',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'stale-ocr.txt',
      'employee_count:42',
    );
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'employment_proof',
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
      payload: { mode: 'async' },
    });
    await getRows(
      `
        UPDATE ocr_jobs
        SET status = 'running',
            attempt_count = 1,
            max_attempts = 3,
            locked_by = 'dead-worker',
            locked_at = now() - interval '1 hour'
        WHERE material_id = $1
      `,
      [materialId],
    );

    const reclaimed = await claimNextOcrJob({
      worker_id: 'worker-reclaim',
      stale_running_ms: 1,
    });
    expect(reclaimed?.attempt_count).toBe(2);
    expect(reclaimed?.locked_by).toBe('worker-reclaim');

    await getRows(
      `
        UPDATE ocr_jobs
        SET status = 'running',
            attempt_count = max_attempts - 1,
            locked_by = 'dead-worker',
            locked_at = now() - interval '1 hour'
        WHERE material_id = $1
      `,
      [materialId],
    );
    const exhausted = await claimNextOcrJob({
      worker_id: 'worker-reclaim',
      stale_running_ms: 1,
    });
    expect(exhausted).toBeUndefined();
    const rows = await getRows<{
      status: string;
      attempt_count: number;
      last_error: string;
      material_status: string;
      audit_count: string;
    }>(
      `
        SELECT
          j.status,
          j.attempt_count,
          j.last_error,
          m.ocr_status::text AS material_status,
          (
            SELECT COUNT(*)::text
            FROM audit_logs
            WHERE action = 'material.ocr.analyze_failed'
              AND target_id = m.material_id::text
          ) AS audit_count
        FROM ocr_jobs j
        INNER JOIN materials m ON m.material_id = j.material_id
        WHERE j.material_id = $1
      `,
      [materialId],
    );
    expect(rows[0]).toMatchObject({
      status: 'failed',
      attempt_count: 3,
      last_error: 'ocr worker lease expired',
      material_status: 'failed',
      audit_count: '1',
    });
    await app.close();
  });

  it('does not let stale OCR cleanup overwrite an existing success status', async () => {
    setOcrProviderForTest({
      async analyze() {
        return {
          material_type: 'employment_proof',
          fields: { enterprise_name: 'Stale Success OCR Enterprise', employee_count: 10 },
          field_confidence: { enterprise_name: 0.95, employee_count: 0.95 },
          overall_confidence: 0.95,
          warnings: [],
        };
      },
    });
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000620',
      enterpriseName: 'Stale Success OCR Enterprise',
      creditCode: '913607FF0000000620',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'stale-success-ocr.txt',
      'employee_count:10',
    );
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'employment_proof',
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
      payload: { mode: 'provider' },
    });
    expect(ocr.json().data.ocr_status).toBe('success');
    await getRows(
      `
        INSERT INTO ocr_jobs (
          material_id,
          actor_id,
          trace_id,
          status,
          attempt_count,
          max_attempts,
          locked_by,
          locked_at
        )
        SELECT
          $1,
          eu.user_id,
          'stale-success-cleanup',
          'running',
          2,
          3,
          'dead-worker',
          now() - interval '1 hour'
        FROM enterprise_accounts eu
        WHERE eu.enterprise_id = $2
        LIMIT 1
      `,
      [materialId, context.enterpriseId],
    );

    expect(await claimNextOcrJob({ worker_id: 'worker-reclaim', stale_running_ms: 1 }))
      .toBeUndefined();
    const rows = await getRows<{
      material_status: string;
      job_status: string;
      audit_count: string;
      result_count: string;
    }>(
      `
        SELECT
          m.ocr_status::text AS material_status,
          j.status AS job_status,
          (
            SELECT COUNT(*)::text
            FROM audit_logs
            WHERE action = 'material.ocr.analyze_failed'
              AND target_id = m.material_id::text
          ) AS audit_count,
          (
            SELECT COUNT(*)::text
            FROM ocr_results
            WHERE material_id = m.material_id
          ) AS result_count
        FROM materials m
        INNER JOIN ocr_jobs j ON j.material_id = m.material_id
        WHERE m.material_id = $1
      `,
      [materialId],
    );
    expect(rows[0]).toEqual({
      material_status: 'success',
      job_status: 'failed',
      audit_count: '0',
      result_count: '1',
    });
    await app.close();
  });

  it('does not let final async failure overwrite existing success or low confidence statuses', async () => {
    const app = await buildApp();
    for (const [index, status] of ['success', 'low_confidence'].entries()) {
      const context = await createNeedSupplementApplication(app, {
        phone: `1391000062${index + 2}`,
        enterpriseName: `Final Failure Guard ${status}`,
        creditCode: `913607FF000000062${index + 2}`,
      });
      const upload = await uploadFile(
        app,
        context.enterpriseToken,
        context.enterpriseId,
        `final-failure-${status}.txt`,
        'employee_count:12',
      );
      const supplement = await app.inject({
        method: 'POST',
        url: `/api/v1/applications/${context.applicationId}/supplements`,
        headers: { authorization: `Bearer ${context.enterpriseToken}` },
        payload: {
          materials: [
            {
              material_type: 'employment_proof',
              file_id: upload.json().data.file_id,
              mode: 'append',
            },
          ],
        },
      });
      const materialId = supplement.json().data.materials[0].material_id;
      await getRows(
        'UPDATE materials SET ocr_status = $2 WHERE material_id = $1',
        [materialId, status],
      );
      await ocrService.markAnalyzeFailed(
        'test-worker',
        `final-failure-${status}`,
        materialId,
        'final async OCR failure',
      );
      const rows = await getRows<{
        material_status: string;
        audit_count: string;
      }>(
        `
          SELECT
            m.ocr_status::text AS material_status,
            (
              SELECT COUNT(*)::text
              FROM audit_logs
              WHERE action = 'material.ocr.analyze_failed'
                AND target_id = m.material_id::text
            ) AS audit_count
          FROM materials m
          WHERE m.material_id = $1
        `,
        [materialId],
      );
      expect(rows[0]).toEqual({
        material_status: status,
        audit_count: '0',
      });
    }
    await app.close();
  });

  it('keeps long OCR jobs leased with heartbeat so another worker does not duplicate processing', async () => {
    const previousOcrTimeout = process.env.OCR_SERVICE_TIMEOUT_MS;
    const previousStaleMs = process.env.AGENT_RUN_STALE_RUNNING_MS;
    let resolveAnalyze: (() => void) | undefined;
    let calls = 0;
    setOcrProviderForTest({
      async analyze() {
        calls += 1;
        await new Promise<void>((resolve) => {
          resolveAnalyze = resolve;
        });
        return {
          material_type: 'employment_proof',
          fields: { enterprise_name: 'Long OCR Enterprise', employee_count: 7 },
          field_confidence: { enterprise_name: 0.95, employee_count: 0.95 },
          overall_confidence: 0.95,
          warnings: [],
        };
      },
    });
    process.env.OCR_SERVICE_TIMEOUT_MS = '300';
    process.env.AGENT_RUN_STALE_RUNNING_MS = '200';
    const app = await buildApp();
    try {
      const context = await createNeedSupplementApplication(app, {
        phone: '13910000616',
        enterpriseName: 'Long OCR Enterprise',
        creditCode: '913607FF0000000616',
      });
      const upload = await uploadFile(
        app,
        context.enterpriseToken,
        context.enterpriseId,
        'long-ocr.txt',
        'employee_count:7',
      );
      const supplement = await app.inject({
        method: 'POST',
        url: `/api/v1/applications/${context.applicationId}/supplements`,
        headers: { authorization: `Bearer ${context.enterpriseToken}` },
        payload: {
          materials: [
            {
              material_type: 'employment_proof',
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
        payload: { mode: 'async' },
      });

      const firstDrain = ocrJobWorker.drainOnce(1);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(await ocrJobWorker.drainOnce(1)).toBe(0);
      resolveAnalyze?.();
      expect(await firstDrain).toBe(1);
      expect(calls).toBe(1);
    } finally {
      if (previousOcrTimeout === undefined) {
        delete process.env.OCR_SERVICE_TIMEOUT_MS;
      } else {
        process.env.OCR_SERVICE_TIMEOUT_MS = previousOcrTimeout;
      }
      if (previousStaleMs === undefined) {
        delete process.env.AGENT_RUN_STALE_RUNNING_MS;
      } else {
        process.env.AGENT_RUN_STALE_RUNNING_MS = previousStaleMs;
      }
      await app.close();
    }
  });

  it('keeps heartbeat earlier than stale reclaim when OCR timeout exceeds stale window', async () => {
    const previousOcrTimeout = process.env.OCR_SERVICE_TIMEOUT_MS;
    const previousStaleMs = process.env.AGENT_RUN_STALE_RUNNING_MS;
    let resolveAnalyze: (() => void) | undefined;
    let calls = 0;
    setOcrProviderForTest({
      async analyze() {
        calls += 1;
        await new Promise<void>((resolve) => {
          resolveAnalyze = resolve;
        });
        return {
          material_type: 'employment_proof',
          fields: { enterprise_name: 'Heartbeat OCR Enterprise', employee_count: 8 },
          field_confidence: { enterprise_name: 0.95, employee_count: 0.95 },
          overall_confidence: 0.95,
          warnings: [],
        };
      },
    });
    process.env.OCR_SERVICE_TIMEOUT_MS = '5000';
    process.env.AGENT_RUN_STALE_RUNNING_MS = '300';
    const app = await buildApp();
    try {
      const context = await createNeedSupplementApplication(app, {
        phone: '13910000618',
        enterpriseName: 'Heartbeat OCR Enterprise',
        creditCode: '913607FF0000000618',
      });
      const upload = await uploadFile(
        app,
        context.enterpriseToken,
        context.enterpriseId,
        'heartbeat-ocr.txt',
        'employee_count:8',
      );
      const supplement = await app.inject({
        method: 'POST',
        url: `/api/v1/applications/${context.applicationId}/supplements`,
        headers: { authorization: `Bearer ${context.enterpriseToken}` },
        payload: {
          materials: [
            {
              material_type: 'employment_proof',
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
        payload: { mode: 'async' },
      });

      const firstDrain = ocrJobWorker.drainOnce(1);
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(await ocrJobWorker.drainOnce(1)).toBe(0);
      resolveAnalyze?.();
      expect(await firstDrain).toBe(1);
      expect(calls).toBe(1);
      const rows = await getRows<{ status: string; attempt_count: number }>(
        'SELECT status, attempt_count FROM ocr_jobs WHERE material_id = $1',
        [materialId],
      );
      expect(rows[0]).toEqual({ status: 'completed', attempt_count: 1 });
    } finally {
      if (previousOcrTimeout === undefined) {
        delete process.env.OCR_SERVICE_TIMEOUT_MS;
      } else {
        process.env.OCR_SERVICE_TIMEOUT_MS = previousOcrTimeout;
      }
      if (previousStaleMs === undefined) {
        delete process.env.AGENT_RUN_STALE_RUNNING_MS;
      } else {
        process.env.AGENT_RUN_STALE_RUNNING_MS = previousStaleMs;
      }
      await app.close();
    }
  });

  it('marks material failed when queued OCR cannot read the stored file', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000617',
      enterpriseName: 'Missing OCR File Enterprise',
      creditCode: '913607FF0000000617',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'missing-ocr.txt',
      'employee_count:42',
    );
    const supplement = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${context.applicationId}/supplements`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {
        materials: [
          {
            material_type: 'employment_proof',
            file_id: upload.json().data.file_id,
            mode: 'append',
          },
        ],
      },
    });
    const materialId = supplement.json().data.materials[0].material_id;
    const fileRows = await getRows<{ storage_key: string }>(
      'SELECT storage_key FROM files WHERE file_id = $1',
      [upload.json().data.file_id],
    );
    await fs.rm(localFileStorageService.resolveStoragePath(fileRows[0].storage_key), {
      force: true,
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/materials/${materialId}/ocr`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: { mode: 'async' },
    });
    await getRows(
      'UPDATE ocr_jobs SET attempt_count = max_attempts - 1 WHERE material_id = $1',
      [materialId],
    );

    expect(await ocrJobWorker.drainOnce(1)).toBe(1);
    const rows = await getRows<{
      material_status: string;
      job_status: string;
      audit_count: string;
    }>(
      `
        SELECT
          m.ocr_status::text AS material_status,
          j.status AS job_status,
          (
            SELECT COUNT(*)::text
            FROM audit_logs
            WHERE action = 'material.ocr.analyze_failed'
              AND target_id = m.material_id::text
          ) AS audit_count
        FROM materials m
        INNER JOIN ocr_jobs j ON j.material_id = m.material_id
        WHERE m.material_id = $1
      `,
      [materialId],
    );
    expect(rows[0]).toEqual({
      material_status: 'failed',
      job_status: 'failed',
      audit_count: '1',
    });
    await app.close();
  });

  it('returns the latest OCR result for a material', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000612',
      enterpriseName: 'Ocr Latest Enterprise',
      creditCode: '913607FF0000000612',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'ocr-latest-license-success.json',
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

    await app.inject({
      method: 'POST',
      url: `/api/v1/materials/${materialId}/ocr`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
      payload: {},
    });
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
          $2::jsonb,
          $3::jsonb,
          0.82,
          $4::jsonb,
          true
        )
      `,
      [
        materialId,
        JSON.stringify({
          enterprise_name: 'Nankang Furniture Co',
          credit_code: '913607XX0000000000',
        }),
        JSON.stringify({
          enterprise_name: 0.92,
          credit_code: 0.82,
        }),
        JSON.stringify(['credit_code low confidence; manual confirmation required']),
      ],
    );
    await getRows(
      "UPDATE materials SET ocr_status = 'low_confidence' WHERE material_id = $1",
      [materialId],
    );
    const latest = await app.inject({
      method: 'GET',
      url: `/api/v1/materials/${materialId}/ocr`,
      headers: { authorization: `Bearer ${context.enterpriseToken}` },
    });

    expect(latest.statusCode).toBe(200);
    expect(latest.json().data.requires_manual_confirmation).toBe(true);
    expect(latest.json().data.overall_confidence).toBe(0.82);
    await app.close();
  });

  it('marks business_license OCR low confidence as manual confirmation required', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000608',
      enterpriseName: 'Ocr Low Enterprise',
      creditCode: '913607FF0000000608',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'ocr-low-license.json',
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

    expect(ocr.statusCode).toBe(200);
    expect(ocr.json().data.requires_manual_confirmation).toBe(true);
    expect(ocr.json().data.ocr_status).toBe('low_confidence');
    expect(ocr.json().data.eligibility_result).toBeUndefined();

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

  it('rejects OCR access for another enterprise material', async () => {
    const app = await buildApp();
    const context = await createNeedSupplementApplication(app, {
      phone: '13910000609',
      enterpriseName: 'Ocr Boundary Enterprise',
      creditCode: '913607FF0000000609',
    });
    const other = await registerAndLogin(app, {
      name: 'Other OCR Enterprise',
      phone: '13910000610',
      password: 'secret123',
    });
    const upload = await uploadFile(
      app,
      context.enterpriseToken,
      context.enterpriseId,
      'ocr-boundary-success.json',
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
      headers: { authorization: `Bearer ${other.token}` },
      payload: {},
    });

    expect(ocr.statusCode).toBe(403);
    await app.close();
  });
});
