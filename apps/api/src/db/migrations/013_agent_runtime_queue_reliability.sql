ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS chk_agent_runs_status;

ALTER TABLE agent_runs
  ADD CONSTRAINT chk_agent_runs_status CHECK (
    status IN ('queued', 'running', 'resuming', 'resume_failed', 'interrupted', 'completed', 'failed', 'cancelled')
  );

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 0;

ALTER TABLE agent_run_jobs
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_jobs_one_active_resume
ON agent_run_jobs(run_id)
WHERE job_type = 'resume' AND status IN ('queued', 'running');

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_resume_requests_one_active_task
ON agent_resume_requests(run_id, task_id)
WHERE status = 'running';
