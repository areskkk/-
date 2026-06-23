import { loadEnv } from '../../config/env.js';
import { ApiError } from '../../common/errors/http-error.js';
import {
  type RagBackendMode,
  type RagCandidate,
} from './rag.types.js';

type SidecarIndexRequest = {
  policy_id: string;
};

type SidecarSearchRequest = {
  query: string;
  policy_id?: string;
  limit: number;
};

type SidecarIndexResponse = {
  backend_mode: RagBackendMode;
  policy_id: string;
  version: string;
  chunk_count: number;
  index_strategy: 'delete_then_insert';
};

type SidecarSearchResponse = {
  backend_mode: RagBackendMode;
  results: Array<{
    chunk_id: string;
    policy_id: string;
    version: string;
    title: string;
    section_path: string;
    chunk_order: number;
    source_name: string | null;
    source_url: string | null;
    content: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
};

export type HaystackSearchInput = SidecarSearchRequest;

export type HaystackSearchResult = {
  backend_mode: RagBackendMode;
  candidates: RagCandidate[];
  degraded: boolean;
  degrade_reason:
    | 'sidecar_unconfigured'
    | 'sidecar_unreachable'
    | 'sidecar_timeout'
    | 'sidecar_invalid_response'
    | 'no_candidates'
    | null;
};

function isRagBackendMode(value: unknown): value is RagBackendMode {
  return (
    value === 'haystack_pgvector'
    || value === 'haystack_inmemory'
    || value === 'local_fallback'
  );
}

function isValidIndexResponse(value: unknown): value is SidecarIndexResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const response = value as SidecarIndexResponse;
  return (
    isRagBackendMode(response.backend_mode)
    && typeof response.policy_id === 'string'
    && typeof response.version === 'string'
    && typeof response.chunk_count === 'number'
    && response.index_strategy === 'delete_then_insert'
  );
}

function isValidSearchResponse(value: unknown): value is SidecarSearchResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const response = value as SidecarSearchResponse;
  if (!isRagBackendMode(response.backend_mode) || !Array.isArray(response.results)) {
    return false;
  }

  return response.results.every((item) =>
    item
    && typeof item === 'object'
    && typeof item.chunk_id === 'string'
    && typeof item.policy_id === 'string'
    && typeof item.version === 'string'
    && typeof item.title === 'string'
    && typeof item.section_path === 'string'
    && typeof item.chunk_order === 'number'
    && (item.source_name === null || typeof item.source_name === 'string')
    && (item.source_url === null || typeof item.source_url === 'string')
    && typeof item.content === 'string'
    && typeof item.score === 'number'
    && item.metadata
    && typeof item.metadata === 'object'
  );
}

export class HaystackClient {
  private env() {
    return loadEnv();
  }

  isConfigured(): boolean {
    return Boolean(this.env().ragServiceBaseUrl);
  }

  private async postJson(path: string, payload: unknown): Promise<unknown> {
    const env = this.env();
    if (!env.ragServiceBaseUrl) {
      throw new ApiError('INTERNAL_ERROR', 'rag sidecar base url is not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), env.ragServiceTimeoutMs);

    try {
      const response = await fetch(new URL(path, env.ragServiceBaseUrl).toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'close',
          ...internalAuthHeaders(env.ragServiceInternalApiKey),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ApiError(
          'INTERNAL_ERROR',
          `rag sidecar request failed with status ${response.status}`,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        throw new ApiError('INTERNAL_ERROR', 'rag sidecar returned non-json response');
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async indexPolicy(input: SidecarIndexRequest): Promise<SidecarIndexResponse> {
    const payload = await this.postJson('/rag/index/policy', input);
    if (!isValidIndexResponse(payload)) {
      throw new ApiError('INTERNAL_ERROR', 'invalid rag sidecar index response');
    }

    return payload;
  }

  async search(input: HaystackSearchInput): Promise<HaystackSearchResult> {
    if (!this.isConfigured()) {
      return {
        backend_mode: 'local_fallback',
        candidates: [],
        degraded: true,
        degrade_reason: 'sidecar_unconfigured',
      };
    }

    try {
      const payload = await this.postJson('/rag/search', input);
      if (!isValidSearchResponse(payload)) {
        return {
          backend_mode: 'local_fallback',
          candidates: [],
          degraded: true,
          degrade_reason: 'sidecar_invalid_response',
        };
      }

      return {
        backend_mode: payload.backend_mode,
        candidates: payload.results.map((item) => ({
          chunk_id: item.chunk_id,
          score: item.score,
          snippet: item.content,
          title: item.title,
          section_path: item.section_path,
          metadata: item.metadata,
        })),
        degraded: payload.results.length === 0,
        degrade_reason: payload.results.length === 0 ? 'no_candidates' : null,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          backend_mode: 'local_fallback',
          candidates: [],
          degraded: true,
          degrade_reason: 'sidecar_timeout',
        };
      }

      return {
        backend_mode: 'local_fallback',
        candidates: [],
        degraded: true,
        degrade_reason: 'sidecar_unreachable',
      };
    }
  }
}

export const haystackClient = new HaystackClient();

function internalAuthHeaders(apiKey: string | null): Record<string, string> {
  return apiKey
    ? { 'x-internal-api-key': apiKey }
    : {};
}
