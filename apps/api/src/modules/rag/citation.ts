import { type RagCitation, type RagPolicyChunkRow } from './rag.types.js';
import { extractRagQueryTerms, normalizeForContains } from './query-normalization.js';

function makeSnippet(content: string, query: string): string {
  const normalizedContent = normalizeForContains(content);
  const normalizedQuery = normalizeForContains(query);
  const queryTerms = extractRagQueryTerms(query);
  const termMatches = [normalizedQuery, ...queryTerms].filter(Boolean);

  let matchedTerm = '';
  let index = -1;
  for (const term of termMatches) {
    index = normalizedContent.indexOf(term);
    if (index >= 0) {
      matchedTerm = term;
      break;
    }
  }

  const start = index >= 0 ? Math.max(0, index - 40) : 0;
  const end = index >= 0
    ? Math.min(content.length, index + matchedTerm.length + 120)
    : Math.min(content.length, 180);

  return content.slice(start, end);
}

export function citationFromChunk(
  chunk: RagPolicyChunkRow,
  score: number,
  query: string,
): RagCitation {
  return {
    citation_id: `${chunk.policy_id}:${chunk.version}:${chunk.chunk_order}`,
    chunk_id: chunk.chunk_id,
    policy_id: chunk.policy_id,
    version: chunk.version,
    title: chunk.title,
    section_path: chunk.section_path,
    chunk_order: chunk.chunk_order,
    source_name: chunk.source_name,
    source_url: chunk.source_url,
    snippet: makeSnippet(chunk.content, query),
    score,
    status: chunk.status,
  };
}
