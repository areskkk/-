export type RagBackendMode =
  | 'haystack_pgvector'
  | 'haystack_inmemory'
  | 'local_fallback';

export type RagSearchStatus = 'matched' | 'low_confidence' | 'no_match';

export type RagPolicyChunkInput = {
  policy_id: string;
  version: string;
  title: string;
  section_path: string;
  chunk_order: number;
  content: string;
  content_hash: string;
  source_name: string | null;
  source_url: string | null;
  status: string;
  metadata: Record<string, unknown>;
  rag_document_id?: string | null;
  rag_chunk_id?: string | null;
};

export type RagPolicyChunkRow = RagPolicyChunkInput & {
  chunk_id: string;
  indexed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RagCitation = {
  citation_id: string;
  chunk_id: string;
  policy_id: string;
  version: string;
  title: string;
  section_path: string;
  chunk_order: number;
  source_name: string | null;
  source_url: string | null;
  snippet: string;
  score: number;
  status: string;
};

export type RagSearchRequest = {
  query: string;
  policy_id?: string;
  limit?: number;
  create_fallback_task?: boolean;
};

export type RagSearchResult = {
  status: RagSearchStatus;
  backend_mode: RagBackendMode;
  confidence: number;
  citations: RagCitation[];
  fallback_task: {
    task_id: string;
    created: boolean;
  } | null;
  degrade_reason?:
    | 'sidecar_unconfigured'
    | 'sidecar_unreachable'
    | 'sidecar_timeout'
    | 'sidecar_invalid_response'
    | 'no_candidates'
    | null;
};

export type RagCandidate = {
  chunk_id: string;
  score: number;
  snippet?: string;
  title?: string;
  section_path?: string;
  metadata?: Record<string, unknown>;
};
