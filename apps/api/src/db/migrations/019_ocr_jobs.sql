CREATE TABLE IF NOT EXISTS ocr_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id uuid NOT NULL REFERENCES materials(material_id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  trace_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  locked_by text,
  locked_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ocr_jobs_status CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT chk_ocr_jobs_attempts CHECK (attempt_count >= 0 AND max_attempts > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ocr_jobs_one_active_per_material
ON ocr_jobs(material_id)
WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_ocr_jobs_claim
ON ocr_jobs(status, available_at, created_at);

CREATE TRIGGER trg_ocr_jobs_updated_at
BEFORE UPDATE ON ocr_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
