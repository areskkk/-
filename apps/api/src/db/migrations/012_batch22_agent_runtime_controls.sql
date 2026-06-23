ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS chk_agent_runs_status;

ALTER TABLE agent_runs
  ADD CONSTRAINT chk_agent_runs_status CHECK (
    status IN ('queued', 'running', 'resuming', 'resume_failed', 'interrupted', 'completed', 'failed', 'cancelled')
  );

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS agent_run_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  priority int NOT NULL DEFAULT 100,
  attempt_count int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 1,
  locked_by text,
  locked_at timestamptz,
  heartbeat_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_agent_run_jobs_type CHECK (job_type IN ('start', 'resume')),
  CONSTRAINT chk_agent_run_jobs_status CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_jobs_one_active_start
ON agent_run_jobs(run_id)
WHERE job_type = 'start' AND status IN ('queued', 'running');

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_jobs_one_active_resume
ON agent_run_jobs(run_id)
WHERE job_type = 'resume' AND status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_agent_run_jobs_claim
ON agent_run_jobs(status, available_at, priority, created_at);

CREATE TRIGGER trg_agent_run_jobs_updated_at
BEFORE UPDATE ON agent_run_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS agent_resume_requests (
  resume_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES fallback_tasks(task_id),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  response_run_id uuid REFERENCES agent_runs(run_id),
  error_message text,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT chk_agent_resume_requests_status CHECK (
    status IN ('running', 'completed', 'failed')
  ),
  CONSTRAINT uq_agent_resume_idempotency UNIQUE (run_id, task_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_resume_requests_one_active_task
ON agent_resume_requests(run_id, task_id)
WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_agent_resume_requests_run
ON agent_resume_requests(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_model_health (
  model_name text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count int NOT NULL DEFAULT 0,
  error_count int NOT NULL DEFAULT 0,
  rate_limit_count int NOT NULL DEFAULT 0,
  latency_samples_ms jsonb NOT NULL DEFAULT '[]'::jsonb,
  circuit_open_until timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_agent_model_health_updated_at
BEFORE UPDATE ON agent_model_health
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
