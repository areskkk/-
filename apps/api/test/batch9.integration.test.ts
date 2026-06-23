import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  canConnectDatabase,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';
import { ragService } from '../src/modules/rag/rag.service.js';
import { haystackClient } from '../src/modules/rag/haystack.client.js';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function registerAndLogin(app: TestApp, input: {
  name: string;
  phone: string;
  user_type?: string;
}) {
  const password = 'secret123';
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

async function login(app: TestApp, phone: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { phone, password: 'secret123' },
  });
  return response.json().data.token as string;
}

async function createRoleToken(
  app: TestApp,
  roleCode: string,
  phone: string,
  userType = 'admin',
) {
  const { userId } = await registerAndLogin(app, {
    name: `Batch9 ${roleCode}`,
    phone,
    user_type: userType,
  });
  await assignRole(userId, roleCode);
  return login(app, phone);
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

describeIfDb('batch9 rag retrieval foundation', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    delete process.env.RAG_SERVICE_BASE_URL;
  });

  it('indexes only effective whitelisted policy and is idempotent', async () => {
    const app = await buildApp();
    const policyAdminToken = await createRoleToken(
      app,
      'policy_admin',
      '13910000901',
    );
    const policyId = await createPolicy({
      title: '南康家具数字化技改奖励',
      content: '# 申报条件\n南康家具制造企业完成数字化技改后可申请奖励。\n# 材料要求\n提交设备采购合同。',
    });
    const draftPolicyId = await createPolicy({
      title: '草稿政策',
      content: '草稿不能进入检索。',
      status: 'draft',
    });
    const nonWhitelistPolicyId = await createPolicy({
      title: '非白名单政策',
      content: '非白名单不能进入检索。',
      whitelisted: false,
    });

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyId}/index`,
      headers: { authorization: `Bearer ${policyAdminToken}` },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyId}/index`,
      headers: { authorization: `Bearer ${policyAdminToken}` },
    });
    const draft = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${draftPolicyId}/index`,
      headers: { authorization: `Bearer ${policyAdminToken}` },
    });
    const nonWhitelist = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${nonWhitelistPolicyId}/index`,
      headers: { authorization: `Bearer ${policyAdminToken}` },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().data.chunk_count).toBe(second.json().data.chunk_count);
    expect(first.json().data.strategy).toBe('delete_then_insert');
    expect(first.json().data.backend_mode).toBe('local_fallback');
    expect(draft.statusCode).toBe(404);
    expect(nonWhitelist.statusCode).toBe(404);

    const chunkRows = await getRows<{
      total: string;
      policy_id_count: string;
      metadata_policy_id: string;
      metadata_section_path: string;
    }>(
      `
        SELECT
          COUNT(*)::text AS total,
          COUNT(DISTINCT policy_id)::text AS policy_id_count,
          MAX(metadata->>'policy_id') AS metadata_policy_id,
          MAX(metadata->>'section_path') AS metadata_section_path
        FROM policy_chunks
      `,
    );
    expect(Number(chunkRows[0].total)).toBe(first.json().data.chunk_count);
    expect(chunkRows[0].policy_id_count).toBe('1');
    expect(chunkRows[0].metadata_policy_id).toBe(policyId);
    expect(chunkRows[0].metadata_section_path).toBeTruthy();
    await app.close();
  });

  it('allows only policy_admin and system_admin to run admin rag index', async () => {
    const app = await buildApp();
    const policyId = await createPolicy({
      title: 'Batch9 Permission Policy',
      content: '权限测试政策内容。',
    });
    const systemAdminToken = await createRoleToken(
      app,
      'system_admin',
      '13910000902',
    );
    const kbOperatorToken = await createRoleToken(
      app,
      'kb_operator',
      '13910000903',
    );
    const enterprise = await registerAndLogin(app, {
      name: 'Batch9 Enterprise',
      phone: '13910000904',
    });

    const systemAdmin = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyId}/index`,
      headers: { authorization: `Bearer ${systemAdminToken}` },
    });
    const kbOperator = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyId}/index`,
      headers: { authorization: `Bearer ${kbOperatorToken}` },
    });
    const enterpriseResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/rag/policies/${policyId}/index`,
      headers: { authorization: `Bearer ${enterprise.token}` },
    });

    expect(systemAdmin.statusCode).toBe(200);
    expect(kbOperator.statusCode).toBe(403);
    expect(enterpriseResponse.statusCode).toBe(403);
    await app.close();
  });

  it('returns citation structure from local fallback and re-checks live policy state', async () => {
    const policyId = await createPolicy({
      title: '南康家具绿色制造奖励',
      content: '# 申报条件\n南康家具企业完成绿色制造改造后可以申请绿色制造奖励。',
    });
    await ragService.syncPolicyChunks(
      '00000000-0000-0000-0000-000000000000',
      'batch9-trace',
      policyId,
    );

    const matched = await ragService.search(
      '00000000-0000-0000-0000-000000000000',
      'batch9-trace',
      {
        query: '南康家具企业完成绿色制造改造后可以申请绿色制造奖励',
        policy_id: policyId,
      },
    );
    expect(matched.status).toBe('matched');
    expect(matched.backend_mode).toBe('local_fallback');
    expect(matched.citations[0]).toMatchObject({
      policy_id: policyId,
      version: 'v1',
      title: '南康家具绿色制造奖励',
      source_name: '南康区工信局',
      source_url: 'https://example.gov/rag-policy',
      status: 'effective',
    });
    expect(matched.citations[0].chunk_id).toBeTruthy();
    expect(matched.citations[0].citation_id).toContain(policyId);
    expect(matched.citations[0].snippet).toContain('绿色制造');
    expect(matched.citations[0].section_path).toBe('申报条件');

    await getRows('UPDATE policy_ai_whitelist SET enabled = false WHERE policy_id = $1', [
      policyId,
    ]);
    const afterWhitelistClosed = await ragService.search(
      '00000000-0000-0000-0000-000000000000',
      'batch9-trace',
      {
        query: '南康家具企业完成绿色制造改造后可以申请绿色制造奖励',
        policy_id: policyId,
      },
    );
    expect(afterWhitelistClosed.status).toBe('no_match');
    expect(afterWhitelistClosed.citations).toHaveLength(0);

    await getRows('UPDATE policy_ai_whitelist SET enabled = true WHERE policy_id = $1', [
      policyId,
    ]);
    await getRows("UPDATE policies SET status = 'revoked' WHERE policy_id = $1", [
      policyId,
    ]);
    const afterRevoked = await ragService.search(
      '00000000-0000-0000-0000-000000000000',
      'batch9-trace',
      {
        query: '南康家具企业完成绿色制造改造后可以申请绿色制造奖励',
        policy_id: policyId,
      },
    );
    const remainingChunks = await getRows<{ total: string }>(
      'SELECT COUNT(*)::text AS total FROM policy_chunks WHERE policy_id = $1',
      [policyId],
    );
    expect(afterRevoked.status).toBe('no_match');
    expect(afterRevoked.citations).toHaveLength(0);
    expect(Number(remainingChunks[0].total)).toBeGreaterThan(0);
  });

  it('degrades to local fallback when sidecar is unreachable or invalid', async () => {
    const policyId = await createPolicy({
      title: '南康家具智能制造奖励',
      content: '# 申报条件\n南康家具企业完成智能制造改造后可申请奖励。',
    });
    await ragService.syncPolicyChunks(
      '00000000-0000-0000-0000-000000000000',
      'batch9-trace',
      policyId,
    );

    process.env.RAG_SERVICE_BASE_URL = 'http://127.0.0.1:65530';
    process.env.RAG_SERVICE_TIMEOUT_MS = '100';
    const response = await ragService.search(
      '00000000-0000-0000-0000-000000000000',
      'batch9-trace',
      {
        query: '南康家具企业完成智能制造改造后可申请奖励',
        policy_id: policyId,
      },
    );

    expect(response.backend_mode).toBe('local_fallback');
    expect(response.status).toBe('matched');
    expect(response.citations.length).toBeGreaterThan(0);
  });

  it('recognizes haystack_pgvector as a valid backend mode in sidecar responses', async () => {
    const originalFetch = global.fetch;
    process.env.RAG_SERVICE_BASE_URL = 'http://127.0.0.1:8001';
    process.env.RAG_SERVICE_TIMEOUT_MS = '1000';

    global.fetch = (async () => new Response(
      JSON.stringify({
        backend_mode: 'haystack_pgvector',
        results: [],
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    )) as typeof fetch;

    try {
      const response = await haystackClient.search({
        query: 'test query',
        limit: 3,
      });

      expect(response.backend_mode).toBe('haystack_pgvector');
      expect(response.degrade_reason).toBe('no_candidates');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('creates stable rag_retrieval fallback for low confidence or no match', async () => {
    const actorId = '00000000-0000-0000-0000-000000000001';
    const policyId = await createPolicy({
      title: '南康家具用工补贴',
      content: '# 申报条件\n南康家具企业稳定用工可申请补贴。',
    });
    await ragService.syncPolicyChunks(actorId, 'batch9-trace', policyId);

    const first = await ragService.search(actorId, 'batch9-trace', {
      query: '完全无关的问题',
      policy_id: policyId,
    });
    const duplicate = await ragService.search(actorId, 'batch9-trace', {
      query: '  完全无关的问题!!!  ',
      policy_id: policyId,
    });

    expect(first.status).toBe('no_match');
    expect(first.fallback_task?.created).toBe(true);
    expect(duplicate.fallback_task?.created).toBe(false);
    expect(duplicate.fallback_task?.task_id).toBe(first.fallback_task?.task_id);

    const fallbackRows = await getRows<{
      source_type: string;
      source_id: string;
      reason: string;
      normalized_query: string;
      top_score: string;
      candidate_count: number;
      context_text: string;
    }>(
      `
        SELECT
          source_type,
          source_id,
          reason,
          context->>'normalized_query' AS normalized_query,
          context->>'top_score' AS top_score,
          (context->>'candidate_count')::int AS candidate_count,
          context::text AS context_text
        FROM fallback_tasks
      `,
    );

    expect(fallbackRows).toHaveLength(1);
    expect(fallbackRows[0].source_type).toBe('rag_retrieval');
    expect(fallbackRows[0].source_id).not.toBe('unspecified');
    expect(fallbackRows[0].reason).toBe('rag_retrieval_no_match');
    expect(fallbackRows[0].normalized_query).toBe('完全无关的问题');
    expect(fallbackRows[0].top_score).toBe('0');
    expect(fallbackRows[0].candidate_count).toBe(0);
    expect(fallbackRows[0].context_text).not.toContain('南康家具企业稳定用工可申请补贴');
  });
});
