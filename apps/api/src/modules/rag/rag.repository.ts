import { execute, query, queryOne, withTransaction } from '../../db/query.js';
import { type PolicyRow } from '../policies/policies.repository.js';
import {
  type RagPolicyChunkInput,
  type RagPolicyChunkRow,
} from './rag.types.js';
import { extractRagQueryTerms, normalizeRagQuery } from './query-normalization.js';

export type SearchablePolicyRow = PolicyRow & {
  whitelist_enabled: boolean;
};

export async function findSearchablePolicy(
  policyId: string,
): Promise<SearchablePolicyRow | undefined> {
  return queryOne<SearchablePolicyRow>(
    `
      SELECT
        p.policy_id::text,
        p.title,
        p.department_id::text,
        p.source_type,
        p.source_name,
        p.source_url,
        p.status::text,
        p.version,
        p.effective_date::text,
        p.expire_date::text,
        p.content,
        w.enabled AS whitelist_enabled
      FROM policies p
      JOIN policy_ai_whitelist w ON w.policy_id = p.policy_id
      WHERE p.policy_id = $1
        AND p.status = 'effective'
        AND w.enabled = true
    `,
    [policyId],
  );
}

export async function replacePolicyChunks(input: {
  policy_id: string;
  chunks: RagPolicyChunkInput[];
}): Promise<RagPolicyChunkRow[]> {
  return withTransaction(async (tx) => {
    await tx.execute('DELETE FROM policy_chunks WHERE policy_id = $1', [input.policy_id]);

    const inserted: RagPolicyChunkRow[] = [];
    for (const chunk of input.chunks) {
      const row = await tx.queryOne<RagPolicyChunkRow>(
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
            metadata,
            rag_document_id,
            rag_chunk_id,
            indexed_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11::jsonb,
            $12,
            $13,
            now()
          )
          RETURNING
            chunk_id::text,
            policy_id::text,
            version,
            title,
            section_path,
            chunk_order,
            content,
            content_hash,
            source_name,
            source_url,
            status,
            metadata,
            rag_document_id,
            rag_chunk_id,
            indexed_at::text,
            created_at::text,
            updated_at::text
        `,
        [
          chunk.policy_id,
          chunk.version,
          chunk.title,
          chunk.section_path,
          chunk.chunk_order,
          chunk.content,
          chunk.content_hash,
          chunk.source_name,
          chunk.source_url,
          chunk.status,
          JSON.stringify(chunk.metadata),
          chunk.rag_document_id ?? null,
          chunk.rag_chunk_id ?? null,
        ],
      );

      if (row) {
        inserted.push(row);
      }
    }

    return inserted;
  });
}

export async function countPolicyChunks(policyId: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    'SELECT COUNT(*)::text AS total FROM policy_chunks WHERE policy_id = $1',
    [policyId],
  );
  return Number(row?.total ?? '0');
}

export async function searchLocalChunks(input: {
  query: string;
  policy_id?: string;
  limit: number;
}): Promise<Array<RagPolicyChunkRow & { score: number }>> {
  const normalizedQuery = normalizeRagQuery(input.query);
  const queryTerms = extractRagQueryTerms(input.query);

  return query<RagPolicyChunkRow & { score: number }>(
    `
      WITH raw_terms AS (
        SELECT DISTINCT token
        FROM unnest($4::text[]) AS token
        WHERE length(token) > 1
      ),
      tokenized AS (
        SELECT token
        FROM raw_terms
      ),
      scored AS (
        SELECT
          c.*,
          (
            CASE WHEN lower(c.title) LIKE '%' || lower($1) || '%' THEN 0.35 ELSE 0 END
            + CASE WHEN lower(c.section_path) LIKE '%' || lower($1) || '%' THEN 0.10 ELSE 0 END
            + CASE WHEN lower(c.content) LIKE '%' || lower($1) || '%' THEN 0.45 ELSE 0 END
            + LEAST(0.40, COALESCE((
                SELECT COUNT(*) * 0.08
                FROM tokenized t
                WHERE lower(c.title) LIKE '%' || t.token || '%'
              ), 0))
            + LEAST(0.20, COALESCE((
                SELECT COUNT(*) * 0.05
                FROM tokenized t
                WHERE lower(c.section_path) LIKE '%' || t.token || '%'
              ), 0))
            + LEAST(0.55, COALESCE((
                SELECT COUNT(*) * 0.06
                FROM tokenized t
                WHERE lower(c.content || ' ' || c.title || ' ' || c.section_path)
                  LIKE '%' || t.token || '%'
              ), 0))
          ) AS score
        FROM policy_chunks c
        JOIN policies p ON p.policy_id = c.policy_id
        JOIN policy_ai_whitelist w ON w.policy_id = c.policy_id
        WHERE p.status = 'effective'
          AND w.enabled = true
          AND ($2::uuid IS NULL OR c.policy_id = $2::uuid)
      )
      SELECT
        chunk_id::text,
        policy_id::text,
        version,
        title,
        section_path,
        chunk_order,
        content,
        content_hash,
        source_name,
        source_url,
        status,
        metadata,
        rag_document_id,
        rag_chunk_id,
        indexed_at::text,
        created_at::text,
        updated_at::text,
        score
      FROM scored
      WHERE score > 0
      ORDER BY score DESC, chunk_order ASC
      LIMIT $3
    `,
    [normalizedQuery, input.policy_id ?? null, input.limit, queryTerms],
  );
}

export async function findLiveSearchableChunksByIds(
  chunkIds: string[],
): Promise<RagPolicyChunkRow[]> {
  if (chunkIds.length === 0) {
    return [];
  }

  return query<RagPolicyChunkRow>(
    `
      SELECT
        c.chunk_id::text,
        c.policy_id::text,
        c.version,
        c.title,
        c.section_path,
        c.chunk_order,
        c.content,
        c.content_hash,
        c.source_name,
        c.source_url,
        c.status,
        c.metadata,
        c.rag_document_id,
        c.rag_chunk_id,
        c.indexed_at::text,
        c.created_at::text,
        c.updated_at::text
      FROM policy_chunks c
      JOIN policies p ON p.policy_id = c.policy_id
      JOIN policy_ai_whitelist w ON w.policy_id = c.policy_id
      WHERE c.chunk_id = ANY($1::uuid[])
        AND p.status = 'effective'
        AND w.enabled = true
    `,
    [chunkIds],
  );
}

export async function clearPolicyChunks(policyId: string): Promise<number> {
  return execute('DELETE FROM policy_chunks WHERE policy_id = $1', [policyId]);
}
