import fs from 'node:fs';
import path from 'node:path';
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

process.env.FILE_STORAGE_ROOT = '.tmp/test-uploads';
process.env.FILE_UPLOAD_MAX_BYTES = '1024';

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

async function bindEnterprise(
  app: Awaited<ReturnType<typeof buildApp>>,
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
      VALUES ('Batch4 Policy', 'manual_import', 'effective', 'v1', 'batch4 policy content')
      RETURNING policy_id
    `,
  );
  return rows[0].policy_id;
}

async function createDraftApplication(
  app: Awaited<ReturnType<typeof buildApp>>,
  token: string,
  enterpriseId: string,
) {
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
  return create.json().data.application_id as string;
}

async function uploadFile(
  app: Awaited<ReturnType<typeof buildApp>>,
  token: string,
  enterpriseId: string,
  content = 'hello file',
) {
  const form = new FormData();
  form.set('enterprise_id', enterpriseId);
  form.set('file', new Blob([content], { type: 'text/plain' }), 'license.txt');

  return app.inject({
    method: 'POST',
    url: '/api/v1/files',
    headers: { authorization: `Bearer ${token}` },
    payload: form,
  });
}

describeIfDb('batch4 integration', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    await clearConfiguredTestUploadDir();
  });

  afterAll(async () => {
    await clearConfiguredTestUploadDir();
  });

  it('uploads a file to local storage and writes file metadata and audit log', async () => {
    const app = await buildApp();
    const token = await registerAndLogin(app, {
      name: 'File User',
      phone: '13810000101',
      password: 'secret123',
    });
    const enterpriseId = await bindEnterprise(app, token, {
      enterprise_name: 'File Enterprise',
      credit_code: '913607DD0000000101',
    });

    const upload = await uploadFile(app, token, enterpriseId, 'batch4 upload');

    expect(upload.statusCode).toBe(200);
    expect(upload.json().data.file_id).toBeTruthy();
    expect(upload.json().data.storage_key).toBeUndefined();

    const files = await getRows<{
      file_id: string;
      storage_key: string;
      byte_size: string;
      file_hash: string;
    }>('SELECT file_id, storage_key, byte_size::text, file_hash FROM files');
    expect(files).toHaveLength(1);
    expect(files[0].byte_size).toBe(String('batch4 upload'.length));

    const storedPath = path.resolve(process.env.FILE_STORAGE_ROOT!, files[0].storage_key);
    expect(fs.existsSync(storedPath)).toBe(true);

    const audits = await getRows<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'file.upload'",
    );
    expect(audits).toHaveLength(1);
    await app.close();
  });

  it('rejects upload when actor does not belong to enterprise', async () => {
    const app = await buildApp();
    const tokenA = await registerAndLogin(app, {
      name: 'Upload User A',
      phone: '13810000102',
      password: 'secret123',
    });
    const tokenB = await registerAndLogin(app, {
      name: 'Upload User B',
      phone: '13810000103',
      password: 'secret123',
    });
    const enterpriseA = await bindEnterprise(app, tokenA, {
      enterprise_name: 'Upload Enterprise A',
      credit_code: '913607DD0000000102',
    });

    const upload = await uploadFile(app, tokenB, enterpriseA);

    expect(upload.statusCode).toBe(403);
    await app.close();
  });

  it('binds material to draft application and application detail returns file metadata only', async () => {
    const app = await buildApp();
    const token = await registerAndLogin(app, {
      name: 'Material User',
      phone: '13810000104',
      password: 'secret123',
    });
    const enterpriseId = await bindEnterprise(app, token, {
      enterprise_name: 'Material Enterprise',
      credit_code: '913607DD0000000104',
    });
    const applicationId = await createDraftApplication(app, token, enterpriseId);
    const upload = await uploadFile(app, token, enterpriseId);
    const fileId = upload.json().data.file_id;

    const material = await app.inject({
      method: 'POST',
      url: '/api/v1/materials',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        application_id: applicationId,
        material_type: 'business_license',
        file_id: fileId,
      },
    });

    expect(material.statusCode).toBe(200);
    expect(material.json().data.ocr_status).toBe('pending');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/applications/${applicationId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.materials).toHaveLength(1);
    expect(detail.json().data.materials[0]).toMatchObject({
      file_id: fileId,
      original_filename: 'license.txt',
      mime_type: 'text/plain',
      ocr_status: 'pending',
      security_level: 'L3',
    });
    expect(detail.json().data.materials[0].storage_key).toBeUndefined();

    const materials = await getRows<{ material_id: string }>('SELECT material_id FROM materials');
    const audits = await getRows<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'material.create'",
    );
    expect(materials).toHaveLength(1);
    expect(audits).toHaveLength(1);
    await app.close();
  });

  it('rejects material binding for non-draft application', async () => {
    const app = await buildApp();
    const token = await registerAndLogin(app, {
      name: 'Submitted Material User',
      phone: '13810000105',
      password: 'secret123',
    });
    const enterpriseId = await bindEnterprise(app, token, {
      enterprise_name: 'Submitted Material Enterprise',
      credit_code: '913607DD0000000105',
    });

    await app.inject({
      method: 'PUT',
      url: '/api/v1/enterprise-profile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enterprise_id: enterpriseId,
        enterprise_name: 'Submitted Material Enterprise',
        credit_code: '913607DD0000000105',
        industry: 'furniture',
      },
    });

    const applicationId = await createDraftApplication(app, token, enterpriseId);
    await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${applicationId}/submit`,
      headers: { authorization: `Bearer ${token}` },
    });
    const upload = await uploadFile(app, token, enterpriseId);

    const material = await app.inject({
      method: 'POST',
      url: '/api/v1/materials',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        application_id: applicationId,
        material_type: 'business_license',
        file_id: upload.json().data.file_id,
      },
    });

    expect(material.statusCode).toBe(409);
    await app.close();
  });

  it('rejects material binding when file belongs to another enterprise', async () => {
    const app = await buildApp();
    const tokenA = await registerAndLogin(app, {
      name: 'Boundary User A',
      phone: '13810000106',
      password: 'secret123',
    });
    const tokenB = await registerAndLogin(app, {
      name: 'Boundary User B',
      phone: '13810000107',
      password: 'secret123',
    });
    const enterpriseA = await bindEnterprise(app, tokenA, {
      enterprise_name: 'Boundary Enterprise A',
      credit_code: '913607DD0000000106',
    });
    const enterpriseB = await bindEnterprise(app, tokenB, {
      enterprise_name: 'Boundary Enterprise B',
      credit_code: '913607DD0000000107',
    });
    const applicationA = await createDraftApplication(app, tokenA, enterpriseA);
    const uploadB = await uploadFile(app, tokenB, enterpriseB);

    const material = await app.inject({
      method: 'POST',
      url: '/api/v1/materials',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        application_id: applicationA,
        material_type: 'business_license',
        file_id: uploadB.json().data.file_id,
      },
    });

    expect(material.statusCode).toBe(403);
    await app.close();
  });

  it('cleans local file when database insert fails after stream storage succeeds', async () => {
    const app = await buildApp();
    const token = await registerAndLogin(app, {
      name: 'Cleanup User',
      phone: '13810000108',
      password: 'secret123',
    });
    const enterpriseId = await bindEnterprise(app, token, {
      enterprise_name: 'Cleanup Enterprise',
      credit_code: '913607DD0000000108',
    });

    await getRows('ALTER TABLE files ADD CONSTRAINT test_files_insert_fail CHECK (false)');

    try {
      const upload = await uploadFile(app, token, enterpriseId, 'cleanup');
      expect(upload.statusCode).toBe(500);
    } finally {
      await getRows('ALTER TABLE files DROP CONSTRAINT test_files_insert_fail');
    }

    const uploadRoot = path.resolve(process.env.FILE_STORAGE_ROOT!);
    const remainingFiles = fs
      .readdirSync(uploadRoot, { recursive: true })
      .filter((entry) => fs.statSync(path.join(uploadRoot, String(entry))).isFile());
    expect(remainingFiles).toHaveLength(0);
    await app.close();
  });
});
