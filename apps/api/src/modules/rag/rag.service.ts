import { ApiError } from '../../common/errors/http-error.js';
import { auditService } from '../audit/audit.service.js';
import { loadEnv } from '../../config/env.js';
import {
  createRagRetrievalSourceId,
  fallbackService,
} from '../fallback/fallback.service.js';
import { chunkPolicyContent } from './chunking.js';
import { citationFromChunk } from './citation.js';
import {
  countPolicyChunks,
  findLiveSearchableChunksByIds,
  findSearchablePolicy,
  replacePolicyChunks,
  searchLocalChunks,
} from './rag.repository.js';
import { haystackClient } from './haystack.client.js';
import {
  type RagBackendMode,
  type RagCitation,
  type RagCandidate,
  type RagSearchRequest,
  type RagSearchResult,
} from './rag.types.js';
import {
  extractRagQueryTerms,
  normalizeForContains,
  normalizeRagQuery,
} from './query-normalization.js';

const CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_SEARCH_LIMIT = 5;
const RAG_DEBUG = process.env.RAG_DEBUG === 'true';

function debugLog(message: string, fields: Record<string, unknown>): void {
  if (!RAG_DEBUG) {
    return;
  }

  const payload = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  console.log(`[rag.debug] ${message} | ${payload}`);
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit) || !limit) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(10, Math.trunc(limit)));
}

function countTermHits(value: string | null | undefined, queryTerms: string[]): number {
  if (!value || queryTerms.length === 0) {
    return 0;
  }

  const normalized = normalizeForContains(value);
  return queryTerms.filter((term) => normalized.includes(term)).length;
}

function boostCandidateScore(
  candidate: RagCandidate,
  chunk: Awaited<ReturnType<typeof findLiveSearchableChunksByIds>>[number] | undefined,
  normalizedQuery: string,
  queryTerms: string[],
): number {
  if (!chunk) {
    return Number(candidate.score) || 0;
  }

  const titleHits = countTermHits(chunk.title, queryTerms);
  const sectionHits = countTermHits(chunk.section_path, queryTerms);
  const contentHits = countTermHits(chunk.content, queryTerms);
  const exactTitleHit = normalizedQuery !== '' && normalizeForContains(chunk.title).includes(normalizedQuery);
  const exactSectionHit = normalizedQuery !== '' && normalizeForContains(chunk.section_path).includes(normalizedQuery);
  const exactContentHit = normalizedQuery !== '' && normalizeForContains(chunk.content).includes(normalizedQuery);

  return Number(candidate.score)
    + Math.min(0.24, titleHits * 0.06)
    + Math.min(0.08, sectionHits * 0.02)
    + Math.min(0.12, contentHits * 0.015)
    + (exactTitleHit ? 0.12 : 0)
    + (exactSectionHit ? 0.04 : 0)
    + (exactContentHit ? 0.03 : 0);
}

function computeEvidenceStrength(
  citation: RagCitation | undefined,
  queryTerms: string[],
): number {
  if (!citation || queryTerms.length === 0) {
    return 0;
  }

  const titleHits = countTermHits(citation.title, queryTerms);
  const sectionHits = countTermHits(citation.section_path, queryTerms);
  const snippetHits = countTermHits(citation.snippet, queryTerms);

  return Math.min(
    1,
    titleHits * 0.2 + sectionHits * 0.1 + snippetHits * 0.12,
  );
}

function calibrateConfidence(
  backendMode: RagBackendMode,
  citations: RagCitation[],
  queryTerms: string[],
): number {
  const topScore = citations[0]?.score ?? 0;
  if (topScore <= 0) {
    return 0;
  }

  if (backendMode === 'local_fallback') {
    return Number(Math.min(0.99, topScore).toFixed(4));
  }

  const secondScore = citations[1]?.score ?? 0;
  const separation = Math.max(0, topScore - secondScore);
  const evidenceStrength = computeEvidenceStrength(citations[0], queryTerms);
  const calibrated = topScore - 0.24 + Math.min(0.10, separation * 0.7) + evidenceStrength;
  return Number(Math.max(0, Math.min(0.99, calibrated)).toFixed(4));
}

export class RagService {
  async syncPolicyChunks(actorId: string, traceId: string, policyId: string) {
    if (!policyId) {
      throw new ApiError('VALIDATION_ERROR', 'policy_id is required');
    }

    const policy = await findSearchablePolicy(policyId);
    if (!policy) {
      throw new ApiError(
        'NOT_FOUND',
        'policy is not effective or not enabled in policy_ai_whitelist',
      );
    }

    const chunks = chunkPolicyContent({
      policy_id: policy.policy_id,
      version: policy.version,
      title: policy.title,
      content: policy.content,
      source_name: policy.source_name,
      source_url: policy.source_url,
      status: policy.status,
    });

    const inserted = await replacePolicyChunks({
      policy_id: policyId,
      chunks,
    });

    let backendMode: RagSearchResult['backend_mode'] = 'local_fallback';
    if (haystackClient.isConfigured()) {
      try {
        const indexed = await haystackClient.indexPolicy({ policy_id: policyId });
        backendMode = indexed.backend_mode;
      } catch {
        backendMode = 'local_fallback';
      }
    }

    await auditService.write({
      actor_id: actorId,
      action: 'rag.policy_chunks.sync',
      target_type: 'policy',
      target_id: policyId,
      trace_id: traceId,
      detail: {
        strategy: 'delete_then_insert',
        chunk_count: inserted.length,
        policy_status: policy.status,
        whitelist_enabled: policy.whitelist_enabled,
        backend_mode: backendMode,
      },
    });

    return {
      policy_id: policyId,
      strategy: 'delete_then_insert',
      backend_mode: backendMode,
      chunk_count: inserted.length,
      chunks: inserted.map((chunk) => ({
        chunk_id: chunk.chunk_id,
        section_path: chunk.section_path,
        chunk_order: chunk.chunk_order,
        content_hash: chunk.content_hash,
      })),
    };
  }

  async countChunks(policyId: string): Promise<number> {
    return countPolicyChunks(policyId);
  }

  async search(
    actorId: string,
    traceId: string,
    input: RagSearchRequest,
  ): Promise<RagSearchResult> {
    if (!input.query || input.query.trim() === '') {
      throw new ApiError('VALIDATION_ERROR', 'query is required');
    }

    const normalizedQuery = normalizeRagQuery(input.query);
    const queryTerms = extractRagQueryTerms(input.query);
    const limit = normalizeLimit(input.limit);
    const env = loadEnv();
    const haystackResult = await haystackClient.search({
      query: normalizedQuery,
      policy_id: input.policy_id,
      limit,
    });
    debugLog('after_haystack_client', {
      query: normalizedQuery,
      policy_id: input.policy_id ?? 'no_policy',
      rag_service_base_url: env.ragServiceBaseUrl ?? 'unset',
      rag_service_timeout_ms: env.ragServiceTimeoutMs,
      haystack_backend_mode: haystackResult.backend_mode,
      haystack_candidates: haystackResult.candidates.length,
      haystack_degraded: haystackResult.degraded,
      haystack_degrade_reason: haystackResult.degrade_reason ?? 'none',
    });

    const useSidecarCandidates = haystackResult.candidates.length > 0;
    debugLog('sidecar_candidate_decision', {
      use_sidecar_candidates: useSidecarCandidates,
      haystack_candidates: haystackResult.candidates.length,
    });
    const candidates = useSidecarCandidates
      ? haystackResult.candidates
      : await searchLocalChunks({
          query: normalizedQuery,
          policy_id: input.policy_id,
          limit,
        });
    const backendMode = useSidecarCandidates
      ? haystackResult.backend_mode
      : 'local_fallback';
    debugLog('candidate_source_selected', {
      backend_mode: backendMode,
      candidate_count: candidates.length,
    });

    const candidateIds = candidates.map((candidate) => candidate.chunk_id);
    const liveChunks = await findLiveSearchableChunksByIds(candidateIds);
    debugLog('after_live_chunk_filter', {
      candidate_ids: candidateIds.length,
      live_chunks: liveChunks.length,
    });
    const liveById = new Map(liveChunks.map((chunk) => [chunk.chunk_id, chunk]));
    const rankedCandidates = candidates
      .map((candidate) => ({
        candidate,
        chunk: liveById.get(candidate.chunk_id),
        reranked_score: boostCandidateScore(
          candidate,
          liveById.get(candidate.chunk_id),
          normalizedQuery,
          queryTerms,
        ),
      }))
      .sort((left, right) => right.reranked_score - left.reranked_score);
    const citations: RagCitation[] = rankedCandidates
      .map((candidate) => {
        const chunk = candidate.chunk;
        if (!chunk) {
          return null;
        }
        const score = Number(candidate.reranked_score);
        return citationFromChunk(
          chunk,
          Number(score.toFixed(4)),
          normalizedQuery,
        );
      })
      .filter((citation): citation is RagCitation => Boolean(citation))
      .slice(0, limit);
    debugLog('after_citation_build', {
      citations: citations.length,
      backend_mode: backendMode,
    });

    const confidence = calibrateConfidence(backendMode, citations, queryTerms);
    const status = confidence >= CONFIDENCE_THRESHOLD
      ? 'matched'
      : confidence > 0
        ? 'low_confidence'
        : 'no_match';

    let fallbackTask: RagSearchResult['fallback_task'] = null;
    if (status !== 'matched' && input.create_fallback_task !== false) {
      const fallback = await fallbackService.createIfNotExists({
        actor_id: actorId,
        trace_id: traceId,
        source_type: 'rag_retrieval',
        source_id: createRagRetrievalSourceId({
          actor_id: actorId,
          query: input.query,
          policy_id: input.policy_id,
        }),
        reason: status === 'low_confidence'
          ? 'rag_retrieval_low_confidence'
          : 'rag_retrieval_no_match',
        context: {
          normalized_query: normalizedQuery,
          policy_id: input.policy_id ?? null,
          top_score: confidence,
          candidate_count: candidates.length,
          top_citations: citations.slice(0, 3).map((citation) => ({
            chunk_id: citation.chunk_id,
            policy_id: citation.policy_id,
            section_path: citation.section_path,
            score: citation.score,
          })),
        },
      });
      fallbackTask = {
        task_id: fallback.task.task_id,
        created: fallback.created,
      };
    }

    await auditService.write({
      actor_id: actorId,
      action: 'rag.search',
      target_type: 'rag_retrieval',
      target_id: input.policy_id ?? 'no_policy',
      trace_id: traceId,
      detail: {
        status,
        confidence,
        backend_mode: backendMode,
        candidate_count: candidates.length,
        citation_count: citations.length,
        live_filter: 'policies.status=effective AND policy_ai_whitelist.enabled=true',
        degraded: haystackResult.degraded,
        degrade_reason: haystackResult.degrade_reason,
      },
    });

    return {
      status,
      backend_mode: backendMode,
      confidence,
      citations,
      fallback_task: fallbackTask,
      degrade_reason: haystackResult.degrade_reason,
    };
  }
}

export const ragService = new RagService();
