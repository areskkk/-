CREATE TABLE IF NOT EXISTS policy_chunks (
  chunk_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES policies(policy_id) ON DELETE CASCADE,
  version text NOT NULL,
  title text NOT NULL,
  section_path text NOT NULL,
  chunk_order int NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  source_name text,
  source_url text,
  status text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  rag_document_id text,
  rag_chunk_id text,
  indexed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version, chunk_order)
);

CREATE INDEX IF NOT EXISTS idx_policy_chunks_policy_version
ON policy_chunks(policy_id, version);

CREATE INDEX IF NOT EXISTS idx_policy_chunks_status_created
ON policy_chunks(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_policy_chunks_content_fts
ON policy_chunks USING gin (to_tsvector('simple', content));

CREATE TRIGGER trg_policy_chunks_updated_at
BEFORE UPDATE ON policy_chunks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
