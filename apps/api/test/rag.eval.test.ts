import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ragService } from '../src/modules/rag/rag.service.js';
import {
  canConnectDatabase,
  getRows,
  withDbClient,
} from './db-test-utils.js';
import { RagHeavyTestManager } from './rag-heavy-test-utils.js';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;

const heavy = new RagHeavyTestManager({
  suiteName: 'rag-eval',
  backend: 'haystack_pgvector',
});

type EvalCase = {
  name: string;
  query: string;
  expected_policy_id?: string;
  expected_section_path?: string;
  expected_keywords?: string[];
  expected_bucket: 'strong_hit' | 'weak_hit' | 'should_degrade';
};

type EvalResult = {
  bucket: EvalCase['expected_bucket'];
  status: string;
  confidence: number;
  top1_hit: boolean;
  top3_hit: boolean;
  citation_hit: boolean;
  backend_mode: string;
  fallback_created: boolean;
};

const policyDefinitions = [
  {
    key: 'digital_upgrade',
    title: '南康家具数字化技改奖励',
    section_path: '申报条件',
    content: '# 申报条件\n南康家具制造企业完成数字化改造后可申请数字化技改奖励。',
    chunk: '南康家具制造企业完成数字化改造后可申请数字化技改奖励。',
    keywords: ['数字化', '技改'],
  },
  {
    key: 'green_upgrade',
    title: '南康家具绿色制造奖励',
    section_path: '申报条件',
    content: '# 申报条件\n南康家具企业完成绿色制造改造后可以申请绿色制造奖励。',
    chunk: '南康家具企业完成绿色制造改造后可以申请绿色制造奖励。',
    keywords: ['绿色制造', '改造'],
  },
  {
    key: 'employment',
    title: '南康家具稳岗用工补贴',
    section_path: '申报条件',
    content: '# 申报条件\n南康家具企业稳定用工并缴纳社保后可申请稳岗用工补贴。',
    chunk: '南康家具企业稳定用工并缴纳社保后可申请稳岗用工补贴。',
    keywords: ['稳岗', '用工补贴'],
  },
  {
    key: 'export',
    title: '南康家具出口奖励',
    section_path: '申报条件',
    content: '# 申报条件\n南康家具出口企业按年度出口额可申请出口奖励。',
    chunk: '南康家具出口企业按年度出口额可申请出口奖励。',
    keywords: ['出口额', '出口奖励'],
  },
  {
    key: 'tax',
    title: '南康家具纳税奖励',
    section_path: '申报条件',
    content: '# 申报条件\n南康家具制造企业年度纳税额达到标准后可申请纳税奖励。',
    chunk: '南康家具制造企业年度纳税额达到标准后可申请纳税奖励。',
    keywords: ['纳税额', '纳税奖励'],
  },
];

const evalCases: EvalCase[] = [
  {
    name: 'strong-digital-1',
    query: '南康家具制造企业完成数字化改造后可以申请什么奖励',
    expected_policy_id: 'digital_upgrade',
    expected_section_path: '申报条件',
    expected_keywords: ['数字化', '技改'],
    expected_bucket: 'strong_hit',
  },
  {
    name: 'strong-digital-2',
    query: '数字化技改奖励的申报条件是什么',
    expected_policy_id: 'digital_upgrade',
    expected_section_path: '申报条件',
    expected_keywords: ['数字化', '技改'],
    expected_bucket: 'strong_hit',
  },
  {
    name: 'strong-green-1',
    query: '绿色制造改造后能申请什么奖励',
    expected_policy_id: 'green_upgrade',
    expected_section_path: '申报条件',
    expected_keywords: ['绿色制造'],
    expected_bucket: 'strong_hit',
  },
  {
    name: 'strong-employment-1',
    query: '家具企业稳定用工补贴怎么申请',
    expected_policy_id: 'employment',
    expected_section_path: '申报条件',
    expected_keywords: ['稳岗', '用工补贴'],
    expected_bucket: 'strong_hit',
  },
  {
    name: 'strong-export-1',
    query: '出口额达到标准后可以申请什么奖励',
    expected_policy_id: 'export',
    expected_section_path: '申报条件',
    expected_keywords: ['出口额'],
    expected_bucket: 'strong_hit',
  },
  {
    name: 'weak-upgrade-1',
    query: '制造改造奖励政策有哪些',
    expected_policy_id: 'digital_upgrade',
    expected_section_path: '申报条件',
    expected_keywords: ['改造'],
    expected_bucket: 'weak_hit',
  },
  {
    name: 'weak-upgrade-2',
    query: '家具企业改造后可以拿奖励吗',
    expected_policy_id: 'green_upgrade',
    expected_section_path: '申报条件',
    expected_keywords: ['改造'],
    expected_bucket: 'weak_hit',
  },
  {
    name: 'weak-employment-1',
    query: '社保和稳岗相关政策怎么查',
    expected_policy_id: 'employment',
    expected_section_path: '申报条件',
    expected_keywords: ['社保', '稳岗'],
    expected_bucket: 'weak_hit',
  },
  {
    name: 'weak-export-1',
    query: '外贸企业奖励政策',
    expected_policy_id: 'export',
    expected_section_path: '申报条件',
    expected_keywords: ['出口'],
    expected_bucket: 'weak_hit',
  },
  {
    name: 'weak-tax-1',
    query: '年度税收奖励政策',
    expected_policy_id: 'tax',
    expected_section_path: '申报条件',
    expected_keywords: ['纳税'],
    expected_bucket: 'weak_hit',
  },
  {
    name: 'degrade-1',
    query: '餐饮企业门店装修补贴',
    expected_bucket: 'should_degrade',
  },
  {
    name: 'degrade-2',
    query: '房地产开发税费减免',
    expected_bucket: 'should_degrade',
  },
  {
    name: 'degrade-3',
    query: '直播电商培训补贴',
    expected_bucket: 'should_degrade',
  },
  {
    name: 'degrade-4',
    query: '完全无关的问题',
    expected_bucket: 'should_degrade',
  },
  {
    name: 'degrade-5',
    query: '新能源汽车购置补贴',
    expected_bucket: 'should_degrade',
  },
];

async function createPolicyDataset(): Promise<Record<string, string>> {
  return withDbClient(async (client) => {
    const ids: Record<string, string> = {};
    await client.query('BEGIN');
    try {
      for (let index = 0; index < policyDefinitions.length; index += 1) {
        const definition = policyDefinitions[index];
        const rows = await client.query<{ policy_id: string }>(
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
            VALUES ($1, 'manual_import', '南康区工信局', $2, 'effective', 'v1', $3)
            RETURNING policy_id::text
          `,
          [
            definition.title,
            `https://example.gov/rag-eval/${definition.key}`,
            definition.content,
          ],
        );
        const policyId = rows.rows[0].policy_id;
        ids[definition.key] = policyId;

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
            VALUES ($1, 'v1', $2, $3, 1, $4, $5, '南康区工信局', $6, 'effective', $7::jsonb)
          `,
          [
            policyId,
            definition.title,
            definition.section_path,
            definition.chunk,
            `rag-eval-hash-${index + 1}`,
            `https://example.gov/rag-eval/${definition.key}`,
            JSON.stringify({
              chunk_type: 'section',
              policy_id: policyId,
              version: 'v1',
              title: definition.title,
              section_path: definition.section_path,
              source_name: '南康区工信局',
              source_url: `https://example.gov/rag-eval/${definition.key}`,
              status: 'effective',
            }),
          ],
        );
      }

      await client.query('COMMIT');
      return ids;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

function isCitationHit(
  citations: Array<{
    policy_id: string;
    section_path: string;
    snippet: string;
  }>,
  sample: EvalCase,
  policyMap: Record<string, string>,
): boolean {
  if (!sample.expected_policy_id) {
    return false;
  }

  const expectedPolicyId = policyMap[sample.expected_policy_id];
  return citations.some((citation) => {
    if (citation.policy_id !== expectedPolicyId) {
      return false;
    }

    if (sample.expected_section_path && citation.section_path === sample.expected_section_path) {
      return true;
    }

    if (!sample.expected_keywords || sample.expected_keywords.length === 0) {
      return false;
    }

    return sample.expected_keywords.some((keyword) => citation.snippet.includes(keyword));
  });
}

function summarizeResults(results: EvalResult[]) {
  const total = results.length;
  const top1 = results.filter((item) => item.top1_hit).length;
  const top3 = results.filter((item) => item.top3_hit).length;
  const citationHit = results.filter((item) => item.citation_hit).length;
  const lowConfidence = results.filter((item) => item.status === 'low_confidence').length;
  const noMatch = results.filter((item) => item.status === 'no_match').length;
  const fallback = results.filter((item) => item.fallback_created).length;

  return {
    total,
    top1_hit_rate: top1 / total,
    top3_hit_rate: top3 / total,
    citation_hit_rate: citationHit / total,
    low_confidence_rate: lowConfidence / total,
    no_match_rate: noMatch / total,
    rag_retrieval_fallback_rate: fallback / total,
  };
}

function summarizeBucket(results: EvalResult[]) {
  return {
    total: results.length,
    matched: results.filter((item) => item.status === 'matched').length,
    low_confidence: results.filter((item) => item.status === 'low_confidence').length,
    no_match: results.filter((item) => item.status === 'no_match').length,
    top1_hit_rate: results.length === 0
      ? 0
      : results.filter((item) => item.top1_hit).length / results.length,
    top3_hit_rate: results.length === 0
      ? 0
      : results.filter((item) => item.top3_hit).length / results.length,
    citation_hit_rate: results.length === 0
      ? 0
      : results.filter((item) => item.citation_hit).length / results.length,
  };
}

describeIfDb('rag evaluation baseline', () => {
  beforeAll(async () => {
    await heavy.setupSuite();
  }, 140000);

  beforeEach(async () => {
    await heavy.prepareCase();
  });

  afterAll(async () => {
    await heavy.teardownSuite();
  }, 20000);

  it('builds a reproducible retrieval evaluation baseline on the current pgvector backend', async () => {
    const caseStartedAt = Date.now();
    const policyMap = await createPolicyDataset();

    console.log('rag.eval:health.start');
    const health = await fetch(`${heavy.baseUrl}/health`);
    console.log('rag.eval:health.done', health.status);
    expect(health.status).toBe(200);

    for (const policyId of Object.values(policyMap)) {
      const indexStartedAt = Date.now();
      console.log('rag.eval:index.start', policyId);
      const response = await fetch(`${heavy.baseUrl}/rag/index/policy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy_id: policyId }),
      });
      console.log('rag.eval:index.done', policyId, response.status, Date.now() - indexStartedAt);
      expect(response.status).toBe(200);
      const json = await response.json();
      console.log('rag.eval:index', JSON.stringify({
        policy_id: policyId,
        backend_mode: json.backend_mode,
        chunk_count: json.chunk_count,
      }));
      expect(json.backend_mode).toBe('haystack_pgvector');
    }

    const results: EvalResult[] = [];

    for (const sample of evalCases) {
      const searchStartedAt = Date.now();
      console.log('rag.eval:search.start', sample.name, sample.query);
      try {
        const ragResult = await ragService.search(
          '00000000-0000-0000-0000-000000000777',
          `rag-eval-${sample.name}`,
          {
            query: sample.query,
          },
        );
        console.log('rag.eval:search.done', sample.name, Date.now() - searchStartedAt, ragResult.status, ragResult.backend_mode, ragResult.citations.length);

        const expectedPolicyId = sample.expected_policy_id
          ? policyMap[sample.expected_policy_id]
          : undefined;
        const top1Hit = expectedPolicyId !== undefined
          && ragResult.citations[0]?.policy_id === expectedPolicyId;
        const top3Hit = expectedPolicyId !== undefined
          && ragResult.citations.slice(0, 3).some((citation) => citation.policy_id === expectedPolicyId);
        const citationHit = isCitationHit(ragResult.citations, sample, policyMap);

        results.push({
          bucket: sample.expected_bucket,
          status: ragResult.status,
          confidence: ragResult.confidence,
          top1_hit: top1Hit,
          top3_hit: top3Hit,
          citation_hit: citationHit,
          backend_mode: ragResult.backend_mode,
          fallback_created: Boolean(ragResult.fallback_task?.created),
        });
        console.log('rag.eval:case', JSON.stringify({
          name: sample.name,
          bucket: sample.expected_bucket,
          status: ragResult.status,
          backend_mode: ragResult.backend_mode,
          citation_count: ragResult.citations.length,
          top_policy_id: ragResult.citations[0]?.policy_id ?? null,
          top_score: ragResult.citations[0]?.score ?? null,
        }));
      } catch (error) {
        console.log('rag.eval:search.error', sample.name, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }

    const summary = summarizeResults(results);
    const strong = results.filter((item) => item.bucket === 'strong_hit');
    const weak = results.filter((item) => item.bucket === 'weak_hit');
    const degrade = results.filter((item) => item.bucket === 'should_degrade');

    const strongTop1Rate = strong.filter((item) => item.top1_hit).length / strong.length;
    const weakTop3Rate = weak.filter((item) => item.top3_hit).length / weak.length;
    const degradeSuccessRate = degrade.filter((item) =>
      item.status === 'low_confidence' || item.status === 'no_match').length / degrade.length;

    console.log(
      JSON.stringify(
        {
          backend_mode: 'haystack_pgvector',
          sample_count: summary.total,
          backend_mode_counts: results.reduce<Record<string, number>>((acc, item) => {
            acc[item.backend_mode] = (acc[item.backend_mode] ?? 0) + 1;
            return acc;
          }, {}),
          bucket_counts: {
            strong_hit: strong.length,
            weak_hit: weak.length,
            should_degrade: degrade.length,
          },
          metrics: summary,
          bucket_metrics: {
            strong_hit: summarizeBucket(strong),
            weak_hit: summarizeBucket(weak),
            should_degrade: summarizeBucket(degrade),
          },
          bucket_baseline: {
            strong_top1_hit_rate: strongTop1Rate,
            weak_top3_hit_rate: weakTop3Rate,
            degrade_success_rate: degradeSuccessRate,
          },
        },
        null,
        2,
      ),
    );

    expect(summary.total).toBe(15);
    expect(strong.every((item) => item.backend_mode === 'haystack_pgvector')).toBe(true);

    expect(strongTop1Rate).toBeGreaterThanOrEqual(0.6);
    expect(weakTop3Rate).toBeGreaterThanOrEqual(0);
    expect(degradeSuccessRate).toBeGreaterThanOrEqual(0);

    expect(summary.citation_hit_rate).toBeGreaterThanOrEqual(0.2);
    expect(summary.no_match_rate).toBeGreaterThanOrEqual(0);
    console.log(`rag.eval:total_ms=${Date.now() - caseStartedAt}`);
  }, 180000);
});
