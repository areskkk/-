import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  canConnectDatabase,
  getRows,
  withDbClient,
} from './db-test-utils.js';
import { RagHeavyTestManager } from './rag-heavy-test-utils.js';
import {
  assertReadonlyRagAppUserCannotWriteBusinessTables,
  ensureReadonlyRagAppUser,
  fetchRagReady,
} from './rag-heavy-test-utils.js';
import { ragService } from '../src/modules/rag/rag.service.js';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;

type TestApp = Awaited<ReturnType<typeof buildApp>>;
const heavy = new RagHeavyTestManager({
  suiteName: 'batch11b',
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

async function createPolicyAndChunk() {
  const uniqueSuffix = Math.random().toString(36).slice(2, 10);
  const title = `Batch11B Docker Pgvector Policy ${uniqueSuffix}`;
  const query = '数字化改造奖励';
  return withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const policyRows = await client.query<{ policy_id: string }>(
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
            'https://example.gov/b11b',
            'effective',
            'v1',
            $2
          )
          RETURNING policy_id::text
        `,
        [
          title,
          '# 申报条件\n南康家具企业完成数字化改造后可申请奖励。',
        ],
      );
      const policyId = policyRows.rows[0].policy_id;

      await client.query(
        'INSERT INTO policy_ai_whitelist (policy_id, enabled) VALUES ($1, true)',
        [policyId],
      );
      await client.query(
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
            '申报条件',
            1,
            $3,
            'batch11b-hash-1',
            '南康区工信局',
            'https://example.gov/b11b',
            'effective',
            $4::jsonb
          )
        `,
        [
          policyId,
          title,
          '南康家具企业完成数字化改造后可申请奖励。',
          JSON.stringify({
            chunk_type: 'section',
            policy_id: policyId,
            version: 'v1',
            title,
            section_path: '申报条件',
            source_name: '南康区工信局',
            source_url: 'https://example.gov/b11b',
            status: 'effective',
          }),
        ],
      );

      await client.query('COMMIT');
      return { policyId, query };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

describeIfDb('batch11b pgvector integration', () => {
  beforeAll(async () => {
    await heavy.setupSuite();
  }, 140000);

  beforeEach(async () => {
    await heavy.prepareCase();
  });

  afterAll(async () => {
    await heavy.teardownSuite();
  }, 20000);

  it('reports production-ready pgvector backend and readonly app database gate', async () => {
    const ready = await fetchRagReady(heavy.baseUrl);

    expect(ready.status).toBe('ok');
    expect(ready.checks.backend_mode).toBe('haystack_pgvector');
    expect(ready.checks.persistent_backend_required).toBe(true);
    expect(ready.checks.pgvector_extension).toBe('ok');
    expect(ready.checks.document_store).toBe('ok');
    expect(ready.checks.app_db_readonly_policies).toBe('blocked');
    expect(ready.checks.app_db_readonly_policy_chunks).toBe('blocked');
    expect(ready.checks.app_db_readonly_policy_ai_whitelist).toBe('blocked');
    expect(ready.checks.app_db_readonly_business_tables).toBe('blocked');
  });

  it('indexes and searches through pgvector sidecar and survives sidecar restart', async () => {
    const { policyId, query } = await createPolicyAndChunk();

    const indexResponse = await fetch(`${heavy.baseUrl}/rag/index/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy_id: policyId }),
    });
    const indexJson = await indexResponse.json();
    console.log('batch11b:index', JSON.stringify({
      policy_id: policyId,
      backend_mode: indexJson.backend_mode,
      chunk_count: indexJson.chunk_count,
    }));

    expect(indexResponse.status).toBe(200);
    expect(indexJson.backend_mode).toBe('haystack_pgvector');

    const firstSearch = await fetch(`${heavy.baseUrl}/rag/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: '南康家具企业完成数字化改造后可申请奖励',
        policy_id: policyId,
        limit: 3,
      }),
    });
    const firstSearchJson = await firstSearch.json();
    console.log('batch11b:sidecar-search-1', JSON.stringify({
      policy_id: policyId,
      raw_result_count: firstSearchJson.results.length,
      raw_top_score: firstSearchJson.results[0]?.score ?? null,
    }));

    expect(firstSearch.status).toBe(200);
    expect(firstSearchJson.backend_mode).toBe('haystack_pgvector');
    expect(firstSearchJson.results.length).toBeGreaterThan(0);

    await heavy.restartSidecar();

    const secondSearch = await fetch(`${heavy.baseUrl}/rag/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        policy_id: policyId,
        limit: 3,
      }),
    });
    const secondSearchJson = await secondSearch.json();
    console.log('batch11b:sidecar-search-2', JSON.stringify({
      policy_id: policyId,
      raw_result_count: secondSearchJson.results.length,
      raw_top_score: secondSearchJson.results[0]?.score ?? null,
    }));

    expect(secondSearch.status).toBe(200);
    expect(secondSearchJson.backend_mode).toBe('haystack_pgvector');
    expect(secondSearchJson.results.length).toBeGreaterThan(0);
  }, 90000);

  it('returns haystack_pgvector in node rag search result when sidecar is available', async () => {
    const { policyId, query } = await createPolicyAndChunk();

    await fetch(`${heavy.baseUrl}/rag/index/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy_id: policyId }),
    });

    const result = await ragService.search(
      '00000000-0000-0000-0000-000000000123',
      'batch11b-trace',
      {
        query,
        policy_id: policyId,
        create_fallback_task: false,
      },
    );
    console.log('batch11b:node-search', JSON.stringify({
      policy_id: policyId,
      backend_mode: result.backend_mode,
      final_citations_count: result.citations.length,
      final_top_score: result.citations[0]?.score ?? null,
      status: result.status,
      degrade_reason: result.degrade_reason ?? null,
    }));

    expect(result.backend_mode).toBe('haystack_pgvector');
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('lets policy-qa audit log record haystack_pgvector backend mode', async () => {
    const app = await buildApp();
    const login = await registerAndLogin(app, {
      name: 'Batch11B User',
      phone: '13910001188',
    });
    const token = login.json().data.token as string;
    const { policyId, query } = await createPolicyAndChunk();

    await fetch(`${heavy.baseUrl}/rag/index/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy_id: policyId }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/policy-qa',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        question: query,
        policy_id: policyId,
      },
    });
    console.log('batch11b:policy-qa', JSON.stringify({
      policy_id: policyId,
      status: response.json().data.status,
      citation_count: response.json().data.citations.length,
    }));

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('answered');

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
    expect(auditRows[0].detail.retrieval_backend_mode).toBe('haystack_pgvector');
    expect(auditRows[0].detail.retrieval_degrade_reason).toBeNull();
    await app.close();
  });

  it('runs sidecar index and search with a readonly app database user', async () => {
    await ensureReadonlyRagAppUser();
    await assertReadonlyRagAppUserCannotWriteBusinessTables();
    await heavy.restartSidecar();
    await heavy.prepareCase();

    const { policyId, query } = await createPolicyAndChunk();
    const indexResponse = await fetch(`${heavy.baseUrl}/rag/index/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy_id: policyId }),
    });
    expect(indexResponse.status).toBe(200);
    const indexJson = await indexResponse.json();
    expect(indexJson.backend_mode).toBe('haystack_pgvector');

    const searchResponse = await fetch(`${heavy.baseUrl}/rag/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        policy_id: policyId,
        limit: 3,
      }),
    });
    expect(searchResponse.status).toBe(200);
    const searchJson = await searchResponse.json();
    expect(searchJson.backend_mode).toBe('haystack_pgvector');
    expect(searchJson.results.length).toBeGreaterThan(0);
  }, 90000);
});
