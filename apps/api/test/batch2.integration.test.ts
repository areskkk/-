import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setOcrProviderForTest } from '../src/modules/ocr/providers/ocr-provider.factory.js';
import { type OcrProvider } from '../src/modules/ocr/providers/ocr-provider.js';
import {
  canConnectDatabase,
  createApprovedEnterpriseForUser,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;

function matchingOcrProvider(input: {
  enterpriseName: string;
  creditCode: string;
}): OcrProvider {
  return {
    async analyze() {
      return {
        material_type: 'business_license',
        fields: {
          enterprise_name: input.enterpriseName,
          credit_code: input.creditCode,
        },
        field_confidence: {
          enterprise_name: 0.99,
          credit_code: 0.99,
        },
        overall_confidence: 0.99,
        warnings: [],
      };
    },
  };
}

async function uploadBindingFile(app: Awaited<ReturnType<typeof buildApp>>, token: string) {
  const form = new FormData();
  form.set('purpose', 'enterprise_binding');
  form.set('file', new Blob(['business license'], { type: 'text/plain' }), 'license.txt');

  const upload = await app.inject({
    method: 'POST',
    url: '/api/v1/files',
    headers: { authorization: `Bearer ${token}` },
    payload: form,
  });

  expect(upload.statusCode).toBe(200);
  return upload.json().data.file_id as string;
}

describeIfDb('batch2 integration', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
  });

  afterEach(() => {
    setOcrProviderForTest(null);
  });

  it('register writes users and login returns JWT', async () => {
    const app = await buildApp();

    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'User One',
        phone: '13800000001',
        password: 'secret123',
      },
    });

    expect(register.statusCode).toBe(200);
    const users = await getRows<{ phone: string; password_hash: string }>(
      'SELECT phone, password_hash FROM users WHERE phone = $1',
      ['13800000001'],
    );
    expect(users).toHaveLength(1);
    expect(users[0].password_hash).not.toBe('secret123');

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800000001',
        password: 'secret123',
      },
    });

    expect(login.statusCode).toBe(200);
    expect(login.json().data.token).toBeTruthy();
    await app.close();
  });

  it('jwt can access protected enterprise routes', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'User Two',
        phone: '13800000002',
        password: 'secret123',
      },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800000002',
        password: 'secret123',
      },
    });
    const token = login.json().data.token;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/enterprises/me',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('new enterprise can be agent approved when binding OCR matches', async () => {
    let observedFileBase64: string | undefined;
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'User Three',
        phone: '13800000003',
        password: 'secret123',
      },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800000003',
        password: 'secret123',
      },
    });
    const token = login.json().data.token;
    setOcrProviderForTest({
      async analyze(input) {
        observedFileBase64 = input.file_base64;
        return matchingOcrProvider({
          enterpriseName: 'Nankang Furniture Co',
          creditCode: '913607XX0000000000',
        }).analyze(input);
      },
    });
    const fileId = await uploadBindingFile(app, token);

    const bind = await app.inject({
      method: 'POST',
      url: '/api/v1/enterprises/bind',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        enterprise_name: 'Nankang Furniture Co',
        credit_code: '913607XX0000000000',
        license_file_id: fileId,
      },
    });

    expect(bind.statusCode).toBe(200);
    expect(bind.json().data.status).toBe('agent_approved');
    expect(observedFileBase64).toBe(Buffer.from('business license').toString('base64'));
    expect(bind.json().data.review.ocr.enterprise_name_match).toBe(true);
    expect(bind.json().data.review.ocr.credit_code_match).toBe(true);

    const enterprises = await getRows<{ credit_code: string }>(
      'SELECT credit_code FROM enterprises WHERE credit_code = $1',
      ['913607XX0000000000'],
    );
    const accounts = await getRows<{ role: string; auth_status: string }>(
      'SELECT role, auth_status FROM enterprise_accounts',
    );
    expect(enterprises).toHaveLength(1);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].role).toBe('owner');
    expect(accounts[0].auth_status).toBe('agent_approved');
    await app.close();
  });

  it('existing enterprise with mismatched name stays pending', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Bind User A',
        phone: '13800000008',
        password: 'secret123',
      },
    });
    await getRows(
      `
        INSERT INTO enterprises (name, credit_code, status)
        VALUES ($1, $2, 'active')
      `,
      ['Existing Enterprise', '913607BB0000000001'],
    );

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800000008',
        password: 'secret123',
      },
    });
    const token = login.json().data.token;
    setOcrProviderForTest(matchingOcrProvider({
      enterpriseName: 'Different Name',
      creditCode: '913607BB0000000001',
    }));
    const fileId = await uploadBindingFile(app, token);

    const bind = await app.inject({
      method: 'POST',
      url: '/api/v1/enterprises/bind',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        enterprise_name: 'Different Name',
        credit_code: '913607BB0000000001',
        license_file_id: fileId,
      },
    });

    expect(bind.statusCode).toBe(200);
    expect(bind.json().data.status).toBe('pending');
    expect(bind.json().data.review.existing_enterprise_matched).toBe(true);
    expect(bind.json().data.review.enterprise_name_match).toBe(false);

    const logs = await getRows<{
      detail: {
        final_auth_status: string;
        decision_reason: string;
        risk_items: string[];
      };
    }>(
      'SELECT detail FROM audit_logs WHERE action = $1',
      ['enterprise.bind'],
    );
    expect(logs[0].detail.final_auth_status).toBe('pending');
    expect(logs[0].detail.risk_items).toContain('existing_enterprise_name_mismatch');
    await app.close();
  });

  it('existing enterprise with matched name still stays pending under safer rule', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Bind User B',
        phone: '13800000009',
        password: 'secret123',
      },
    });
    await getRows(
      `
        INSERT INTO enterprises (name, credit_code, status)
        VALUES ($1, $2, 'active')
      `,
      ['Same Name Enterprise', '913607BB0000000002'],
    );

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800000009',
        password: 'secret123',
      },
    });
    const token = login.json().data.token;
    setOcrProviderForTest(matchingOcrProvider({
      enterpriseName: 'Same Name Enterprise',
      creditCode: '913607BB0000000002',
    }));
    const fileId = await uploadBindingFile(app, token);

    const bind = await app.inject({
      method: 'POST',
      url: '/api/v1/enterprises/bind',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        enterprise_name: 'Same Name Enterprise',
        credit_code: '913607BB0000000002',
        license_file_id: fileId,
      },
    });

    expect(bind.statusCode).toBe(200);
    expect(bind.json().data.status).toBe('pending');
    expect(bind.json().data.review.existing_enterprise_matched).toBe(true);
    expect(bind.json().data.review.enterprise_name_match).toBe(true);
    expect(bind.json().data.review.ocr.enterprise_name_match).toBe(true);
    await app.close();
  });

  it('enterprise profile current state supports write and read without creating snapshots', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'User Four',
        phone: '13800000004',
        password: 'secret123',
      },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800000004',
        password: 'secret123',
      },
    });
    const token = login.json().data.token;
    const userId = login.json().data.user.user_id as string;
    const enterpriseId = await createApprovedEnterpriseForUser({
      userId,
      enterpriseName: 'Current Profile Enterprise',
      creditCode: '913607AA0000000001',
    });

    const update = await app.inject({
      method: 'PUT',
      url: '/api/v1/enterprise-profile',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        enterprise_id: enterpriseId,
        enterprise_name: 'Current Profile Enterprise',
        credit_code: '913607AA0000000001',
        industry: 'furniture',
        employee_count: 25,
        profile_json: {
          note: 'current-profile',
        },
      },
    });

    expect(update.statusCode).toBe(200);

    const getProfile = await app.inject({
      method: 'GET',
      url: '/api/v1/enterprise-profile',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(getProfile.statusCode).toBe(200);
    expect(getProfile.json().data.current_profile.industry).toBe('furniture');

    const snapshots = await getRows<{ total: string }>(
      'SELECT COUNT(*)::text AS total FROM enterprise_profile_snapshots',
    );
    expect(Number(snapshots[0].total)).toBe(0);
    await app.close();
  });

  it('policy import and publish write to database and enterprise-facing queries only expose effective policies', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Normal User',
        phone: '13800000005',
        password: 'secret123',
      },
    });

    const normalLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800000005',
        password: 'secret123',
      },
    });
    const normalToken = normalLogin.json().data.token;

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/policies/import',
      headers: {
        authorization: `Bearer ${normalToken}`,
      },
      payload: {
        title: 'Draft Policy Hidden',
        source_type: 'manual_import',
        text: 'draft content',
      },
    });
    expect(forbidden.statusCode).toBe(403);

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Admin User',
        phone: '13800000006',
        password: 'secret123',
        user_type: 'admin',
      },
    });
    await getRows(
      `
        INSERT INTO user_roles (user_id, role_id)
        SELECT u.user_id, r.role_id
        FROM users u, roles r
        WHERE u.phone = $1 AND r.code = 'policy_admin'
        ON CONFLICT DO NOTHING
      `,
      ['13800000006'],
    );

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800000006',
        password: 'secret123',
      },
    });
    const adminToken = adminLogin.json().data.token;

    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/policies/import',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        title: 'Imported Effective Policy',
        source_type: 'manual_import',
        text: 'policy text body',
        file_id: 'file_ref_003',
      },
    });
    expect(imported.statusCode).toBe(200);
    const policyId = imported.json().data.policy_id;

    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/policies/${policyId}/publish`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(publish.statusCode).toBe(200);

    await getRows(
      `
        INSERT INTO policies (title, source_type, status, version, content)
        VALUES ('Draft Hidden Policy', 'manual_import', 'draft', 'v1', 'draft content')
      `,
    );

    const enterpriseList = await app.inject({
      method: 'GET',
      url: '/api/v1/policies',
    });
    expect(enterpriseList.statusCode).toBe(200);
    const titles = enterpriseList.json().data.items.map((item: { title: string }) => item.title);
    expect(titles).toContain('Imported Effective Policy');
    expect(titles).not.toContain('Draft Hidden Policy');

    const draftPolicy = await getRows<{ policy_id: string }>(
      `SELECT policy_id FROM policies WHERE title = 'Draft Hidden Policy'`,
    );
    const draftDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/policies/${draftPolicy[0].policy_id}`,
    });
    expect(draftDetail.statusCode).toBe(404);

    const effectiveDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/policies/${policyId}`,
    });
    expect(effectiveDetail.statusCode).toBe(200);
    await app.close();
  });

  it('audit log writes to database for key mutations', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Audit User',
        phone: '13800000007',
        password: 'secret123',
      },
    });

    const logs = await getRows<{ action: string }>(
      'SELECT action FROM audit_logs ORDER BY created_at ASC',
    );
    expect(logs.some((log) => log.action === 'auth.register')).toBe(true);
    await app.close();
  });
});
