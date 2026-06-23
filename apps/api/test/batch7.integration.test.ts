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

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function registerAndLogin(app: TestApp, input: {
  name: string;
  phone: string;
  password?: string;
}) {
  const password = input.password ?? 'secret123';
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      name: input.name,
      phone: input.phone,
      password,
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

async function createPolicy(input: {
  title: string;
  content: string;
  whitelisted?: boolean;
  effective?: boolean;
  conditions?: Array<{
    field_key: string;
    operator: string;
    target_value: unknown;
    fail_action: string;
    evidence_type?: string;
    message?: string;
  }>;
}) {
  const policy = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, source_name, source_url, status, version, content)
      VALUES ($1, 'manual_import', '南康区工信局', 'https://example.gov/policy', $2, 'v1', $3)
      RETURNING policy_id::text
    `,
    [input.title, input.effective === false ? 'draft' : 'effective', input.content],
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
          fail_action,
          message
        )
        VALUES ($1, $2, $3, $4::jsonb, true, $5, $6, $7)
      `,
      [
        policyId,
        condition.field_key,
        condition.operator,
        JSON.stringify(condition.target_value),
        condition.evidence_type ?? 'profile',
        condition.fail_action,
        condition.message ?? null,
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

async function createEnterpriseContext(app: TestApp, phone: string) {
  const user = await registerAndLogin(app, {
    name: 'Batch7 Enterprise',
    phone,
  });
  const enterpriseId = await bindEnterprise(app, user.token, {
    enterprise_name: '南康智能家具有限公司',
    credit_code: `913607FF000000${phone.slice(-4)}`,
  });
  await app.inject({
    method: 'PUT',
    url: '/api/v1/enterprise-profile',
    headers: { authorization: `Bearer ${user.token}` },
    payload: {
      enterprise_id: enterpriseId,
      enterprise_name: '南康智能家具有限公司',
      credit_code: `913607FF000000${phone.slice(-4)}`,
      industry: '家具制造',
      revenue_amount: 8000000,
      employee_count: 50,
    },
  });
  return { ...user, enterpriseId };
}

describeIfDb('batch7 integration', () => {
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

  it('answers policy QA only with whitelisted citation-backed snippet', async () => {
    const app = await buildApp();
    const user = await registerAndLogin(app, {
      name: 'QA User',
      phone: '13910000701',
    });
    const policyId = await createPolicy({
      title: '南康家具制造技改奖励政策',
      content: '南康家具制造企业完成数字化技改后，可按设备投入申请奖励。',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        policy_id: policyId,
        question: '南康家具制造企业数字化技改奖励怎么申请',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('answered');
    expect(response.json().data.confidence).toBeGreaterThanOrEqual(0.75);
    expect(response.json().data.citations[0].policy_id).toBe(policyId);
    expect(response.json().data.answer).toContain(response.json().data.citations[0].snippet);
    await app.close();
  });

  it('does not answer QA for non-whitelisted or low-confidence questions', async () => {
    const app = await buildApp();
    const user = await registerAndLogin(app, {
      name: 'QA Boundary User',
      phone: '13910000702',
    });
    await createPolicy({
      title: '南康家具出口奖励政策',
      content: '家具出口企业可按出口额申请奖励。',
      whitelisted: false,
    });
    await createPolicy({
      title: '南康家具用工补贴政策',
      content: '家具企业稳定用工可申请补贴。',
      whitelisted: true,
    });

    const noCitation = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { question: '出口奖励怎么申请' },
    });
    const lowConfidence = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { question: '用工' },
    });

    expect(noCitation.json().data.status).toBe('manual_review');
    expect(noCitation.json().data.citations).toHaveLength(0);
    expect(noCitation.json().data.answer).not.toContain('出口额申请奖励');
    expect(lowConfidence.json().data.status).toBe('need_info');
    expect(lowConfidence.json().data.answer).not.toContain('稳定用工可申请补贴');
    await app.close();
  });

  it('checks single-policy eligibility with reviewed DSL rules', async () => {
    const app = await buildApp();
    const context = await createEnterpriseContext(app, '13910000703');
    const policyId = await createPolicy({
      title: '南康家具制造营收奖励政策',
      content: '家具制造企业年营收达到五百万元可申报。',
      conditions: [
        {
          field_key: 'enterprise_profile.industry',
          operator: 'in',
          target_value: ['家具制造'],
          fail_action: 'ineligible',
        },
        {
          field_key: 'enterprise_profile.revenue_amount',
          operator: 'gte',
          target_value: 5000000,
          fail_action: 'need_info',
        },
      ],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_id: policyId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.result).toBe('eligible');
    expect(response.json().data.matched_conditions).toHaveLength(2);
    expect(response.json().data.evidence_refs.length).toBeGreaterThan(0);
    await app.close();
  });

  it('returns need_info and ineligible from rule results without AI override', async () => {
    const app = await buildApp();
    const context = await createEnterpriseContext(app, '13910000704');
    const policyId = await createPolicy({
      title: '南康家具纳税奖励政策',
      content: '家具制造企业年纳税额达到十万元可申报。',
      conditions: [
        {
          field_key: 'enterprise_profile.industry',
          operator: 'in',
          target_value: ['家具制造'],
          fail_action: 'ineligible',
        },
        {
          field_key: 'enterprise_profile.tax_amount',
          operator: 'gte',
          target_value: 100000,
          fail_action: 'need_info',
        },
      ],
    });

    const needInfo = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_id: policyId,
      },
    });
    const ineligible = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_id: policyId,
        profile_snapshot: {
          industry: '餐饮',
          tax_amount: 200000,
        },
      },
    });

    expect(needInfo.json().data.result).toBe('need_info');
    expect(needInfo.json().data.missing_fields).toEqual(['enterprise_profile.tax_amount']);
    expect(ineligible.json().data.result).toBe('ineligible');
    expect(ineligible.json().data.ai_summary).not.toContain('均已满足');
    await app.close();
  });

  it('rejects non-whitelisted policy and mismatched application evidence while accepting policy_ids array', async () => {
    const app = await buildApp();
    const context = await createEnterpriseContext(app, '13910000705');
    const policyId = await createPolicy({
      title: 'Batch7 Whitelist Policy',
      content: '白名单政策',
      conditions: [
        {
          field_key: 'enterprise_profile.industry',
          operator: 'in',
          target_value: ['家具制造'],
          fail_action: 'ineligible',
        },
      ],
    });
    const otherPolicyId = await createPolicy({
      title: 'Batch7 Other Policy',
      content: '非白名单政策',
      whitelisted: false,
      conditions: [
        {
          field_key: 'enterprise_profile.industry',
          operator: 'in',
          target_value: ['家具制造'],
          fail_action: 'ineligible',
        },
      ],
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
    const applicationId = create.json().data.application_id;

    const nonWhitelisted = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_id: otherPolicyId,
      },
    });
    const multiPolicy = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_ids: [policyId],
      },
    });
    const mismatchedApplication = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_id: otherPolicyId,
        application_id: applicationId,
      },
    });

    expect(nonWhitelisted.statusCode).toBe(404);
    expect(multiPolicy.statusCode).toBe(200);
    expect(multiPolicy.json().data.policy_id).toBe(policyId);
    expect(mismatchedApplication.statusCode).toBe(404);
    await app.close();
  });

  it('uses application OCR evidence only after application and policy consistency checks', async () => {
    const app = await buildApp();
    const context = await createEnterpriseContext(app, '13910000706');
    const policyId = await createPolicy({
      title: 'Batch7 OCR Policy',
      content: '营业执照信用代码一致可作为人工复核证据。',
      conditions: [
        {
          field_key: 'ocr.business_license.credit_code',
          operator: 'eq',
          target_value: `913607FF0000000706`,
          evidence_type: 'ocr',
          fail_action: 'manual_review',
        },
      ],
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
    const applicationId = create.json().data.application_id;
    const fileRows = await getRows<{ file_id: string }>(
      `
        INSERT INTO files (
          enterprise_id,
          uploader_user_id,
          original_filename,
          mime_type,
          byte_size,
          file_hash,
          storage_key
        )
        VALUES ($1, $2, 'license.txt', 'text/plain', 10, 'hash-batch7', 'batch7/license.txt')
        RETURNING file_id::text
      `,
      [context.enterpriseId, context.userId],
    );
    const materialRows = await getRows<{ material_id: string }>(
      `
        INSERT INTO materials (application_id, material_type, file_id, file_hash, is_current)
        VALUES ($1, 'business_license', $2, 'hash-batch7', true)
        RETURNING material_id::text
      `,
      [applicationId, fileRows[0].file_id],
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
          '{"credit_code":"913607FF0000000706"}'::jsonb,
          '{"credit_code":0.82}'::jsonb,
          0.82,
          '["low confidence"]'::jsonb,
          true
        )
      `,
      [materialRows[0].material_id],
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/eligibility/check',
      headers: { authorization: `Bearer ${context.token}` },
      payload: {
        enterprise_id: context.enterpriseId,
        policy_id: policyId,
        application_id: applicationId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.result).toBe('manual_review');
    expect(response.json().data.failed_conditions[0].reason).toBe('low_confidence_evidence');
    await app.close();
  });
});
