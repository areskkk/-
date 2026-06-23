import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  canConnectDatabase,
  getRows,
} from './db-test-utils.js';
import { RagHeavyTestManager } from './rag-heavy-test-utils.js';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;

type TestApp = Awaited<ReturnType<typeof buildApp>>;
const heavy = new RagHeavyTestManager({
  suiteName: 'batch10',
  backend: 'haystack_pgvector',
});

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
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { phone: input.phone, password },
  });
}

async function createPolicy(input: {
  title: string;
  content: string;
  status?: string;
  whitelisted?: boolean;
}) {
  const rows = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (
        title,
        source_type,
        source_name,
        source_url,
        status,
        version,
        content
      )
      VALUES (
        $1,
        'manual_import',
        '南康区工信局',
        'https://example.gov/rag-policy',
        $2,
        'v1',
        $3
      )
      RETURNING policy_id::text
    `,
    [input.title, input.status ?? 'effective', input.content],
  );
  const policyId = rows[0].policy_id;

  if (input.whitelisted !== false) {
    await getRows(
      'INSERT INTO policy_ai_whitelist (policy_id, enabled) VALUES ($1, true)',
      [policyId],
    );
  }

  return policyId;
}

async function insertPolicyChunk(policyId: string, input?: {
  title?: string;
  section_path?: string;
  content?: string;
  content_hash?: string;
}) {
  const title = input?.title ?? '南康家具用工补贴';
  const sectionPath = input?.section_path ?? '申报条件';
  const content = input?.content ?? '# 申报条件\n南康家具企业稳定用工可申请补贴。';
  const metadata = {
    chunk_type: 'section',
    policy_id: policyId,
    version: 'v1',
    title,
    section_path: sectionPath,
    source_name: '南康区工信局',
    source_url: 'https://example.gov/rag-policy',
    status: 'effective',
  };

  await getRows(
    `
      INSERT INTO policy_chunks (
        policy_id,
        version,
        title,
        section_path,
        chunk_order,
        content,
        content_hash,
        source_name,
        source_url,
        status,
        metadata
      )
      VALUES (
        $1,
        'v1',
        $2,
        $3,
        1,
        $4,
        $5,
        '南康区工信局',
        'https://example.gov/rag-policy',
        'effective',
        $6::jsonb
      )
    `,
    [
      policyId,
      title,
      sectionPath,
      content,
      input?.content_hash ?? 'hash-batch10-default',
      JSON.stringify(metadata),
    ],
  );
}

describeIfDb('batch10 integration', () => {
  beforeAll(async () => {
    await heavy.setupSuite();
  }, 130000);

  beforeEach(async () => {
    await heavy.prepareCase();
  }, 60000);

  afterAll(async () => {
    await heavy.teardownSuite();
  }, 20000);

  it('uses haystack-backed rag result when sidecar is available', async () => {
    const caseStartedAt = Date.now();
    const app = await buildApp();
    const login = await registerAndLogin(app, {
      name: 'Batch10 User',
      phone: '13910001001',
    });
    const token = login.json().data.token as string;
    const policyId = await createPolicy({
      title: '南康家具数字化改造奖励',
      content: '# 申报条件\n南康家具制造企业完成数字化改造后可申请数字化技改奖励。',
    });

    await insertPolicyChunk(policyId, {
      title: '南康家具数字化改造奖励',
      section_path: '申报条件',
      content: '南康家具制造企业完成数字化改造后可申请数字化技改奖励。',
      content_hash: 'hash-batch10-1',
    });

    const indexStartedAt = Date.now();
    await fetch(`${heavy.baseUrl}/rag/index/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy_id: policyId }),
    });
    console.log(`batch10:case=available:index_ms=${Date.now() - indexStartedAt}`);

    const askStartedAt = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        question: '南康家具制造企业完成数字化改造后可以申请什么奖励',
        policy_id: policyId,
      },
    });
    console.log(`batch10:case=available:policy_qa_ms=${Date.now() - askStartedAt}`);

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('answered');
    expect(response.json().data.answer).toContain(response.json().data.citations[0].snippet);
    expect(response.json().data.citations[0].policy_id).toBe(policyId);

    const auditRows = await getRows<{
      detail: {
        retrieval_backend_mode: string;
      };
    }>(
      `
        SELECT detail
        FROM audit_logs
        WHERE action = 'policy_qa.ask'
        ORDER BY created_at DESC
        LIMIT 1
      `,
    );
    expect(auditRows[0].detail.retrieval_backend_mode).toBe('haystack_pgvector');
    await app.close();
    console.log(`batch10:case=available:total_ms=${Date.now() - caseStartedAt}`);
  }, 90000);

  it('falls back to local_fallback when sidecar is unreachable', async () => {
    const caseStartedAt = Date.now();
    const app = await buildApp();
    const login = await registerAndLogin(app, {
      name: 'Batch10 User 2',
      phone: '13910001002',
    });
    const token = login.json().data.token as string;
    const policyId = await createPolicy({
      title: '南康家具用工补贴',
      content: '# 申报条件\n南康家具企业稳定用工可申请补贴。',
    });

    await insertPolicyChunk(policyId, {
      content_hash: 'hash-batch10-2',
    });

    process.env.RAG_SERVICE_BASE_URL = 'http://127.0.0.1:65530';
    process.env.RAG_SERVICE_TIMEOUT_MS = '100';
    const askStartedAt = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        question: '南康家具用工补贴怎么申请',
        policy_id: policyId,
      },
    });
    console.log(`batch10:case=unreachable:policy_qa_ms=${Date.now() - askStartedAt}`);

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('answered');
    expect(response.json().data.citations.length).toBeGreaterThan(0);

    const auditRows = await getRows<{
      detail: {
        retrieval_backend_mode: string;
        retrieval_degrade_reason: string | null;
      };
    }>(
      `
        SELECT detail
        FROM audit_logs
        WHERE action = 'policy_qa.ask'
        ORDER BY created_at DESC
        LIMIT 1
      `,
    );
    expect(auditRows[0].detail.retrieval_backend_mode).toBe('local_fallback');
    expect(auditRows[0].detail.retrieval_degrade_reason).toBe('sidecar_unreachable');
    await app.close();
    console.log(`batch10:case=unreachable:total_ms=${Date.now() - caseStartedAt}`);
  }, 90000);

  it('falls back to local_fallback when sidecar is reachable but no candidates', async () => {
    const caseStartedAt = Date.now();
    const app = await buildApp();
    const login = await registerAndLogin(app, {
      name: 'Batch10 User 3',
      phone: '13910001003',
    });
    const token = login.json().data.token as string;
    const policyId = await createPolicy({
      title: '南康家具用工补贴',
      content: '# 申报条件\n南康家具企业稳定用工可申请补贴。',
    });

    await insertPolicyChunk(policyId, {
      content_hash: 'hash-batch10-3',
    });

    const askStartedAt = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        question: '完全无关的问题',
        policy_id: policyId,
      },
    });
    console.log(`batch10:case=no_candidates:policy_qa_ms=${Date.now() - askStartedAt}`);

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('need_info');
    expect(response.json().data.citations.length).toBeGreaterThan(0);

    const auditRows = await getRows<{
      detail: {
        retrieval_backend_mode: string;
        retrieval_degrade_reason: string | null;
      };
    }>(
      `
        SELECT detail
        FROM audit_logs
        WHERE action = 'policy_qa.ask'
        ORDER BY created_at DESC
        LIMIT 1
      `,
    );
    expect(auditRows[0].detail.retrieval_backend_mode).toBe('local_fallback');
    expect(auditRows[0].detail.retrieval_degrade_reason).toBe('no_candidates');
    await app.close();
    console.log(`batch10:case=no_candidates:total_ms=${Date.now() - caseStartedAt}`);
  }, 90000);

  it('does not return answered when policy becomes revoked after retrieval had candidates', async () => {
    const caseStartedAt = Date.now();
    const app = await buildApp();
    const login = await registerAndLogin(app, {
      name: 'Batch10 User 4',
      phone: '13910001004',
    });
    const token = login.json().data.token as string;
    const policyId = await createPolicy({
      title: '南康家具用工补贴',
      content: '# 申报条件\n南康家具企业稳定用工可申请补贴。',
    });

    await insertPolicyChunk(policyId, {
      content_hash: 'hash-batch10-4',
    });

    const indexStartedAt = Date.now();
    await fetch(`${heavy.baseUrl}/rag/index/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy_id: policyId }),
    });
    console.log(`batch10:case=revoked:index_ms=${Date.now() - indexStartedAt}`);
    await getRows("UPDATE policies SET status = 'revoked' WHERE policy_id = $1", [policyId]);

    const askStartedAt = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        question: '南康家具用工补贴怎么申请',
        policy_id: policyId,
      },
    });
    console.log(`batch10:case=revoked:policy_qa_ms=${Date.now() - askStartedAt}`);

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).not.toBe('answered');
    expect(response.json().data.citations).toHaveLength(0);
    await app.close();
    console.log(`batch10:case=revoked:total_ms=${Date.now() - caseStartedAt}`);
  }, 90000);
});
