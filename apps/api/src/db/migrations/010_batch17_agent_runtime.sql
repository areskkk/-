CREATE TABLE agent_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL,
  entrypoint text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  current_node text,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  trace_id text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  interrupted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_agent_runs_status CHECK (
    status IN ('running', 'interrupted', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT chk_agent_runs_entrypoint CHECK (
    entrypoint IN ('consultation', 'application', 'review', 'mock_completed', 'mock_failed', 'mock_interrupted')
  )
);

CREATE TABLE agent_run_steps (
  step_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  node_name text NOT NULL,
  agent_type text,
  model_name text,
  prompt_template_id uuid REFERENCES prompt_templates(template_id),
  status text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT chk_agent_run_steps_status CHECK (
    status IN ('running', 'completed', 'failed', 'interrupted')
  )
);

CREATE TABLE agent_tool_calls (
  tool_call_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  step_id uuid REFERENCES agent_run_steps(step_id) ON DELETE SET NULL,
  tool_name text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT chk_agent_tool_calls_status CHECK (
    status IN ('running', 'completed', 'failed')
  )
);

CREATE INDEX idx_agent_runs_actor_started ON agent_runs(actor_id, started_at DESC);
CREATE INDEX idx_agent_runs_trace ON agent_runs(trace_id);
CREATE UNIQUE INDEX idx_agent_runs_idempotency
ON agent_runs(actor_id, entrypoint, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_agent_run_steps_run_started
ON agent_run_steps(run_id, started_at ASC);

CREATE INDEX idx_agent_tool_calls_run_started
ON agent_tool_calls(run_id, started_at ASC);

CREATE INDEX IF NOT EXISTS idx_fallback_tasks_run_id
ON fallback_tasks(run_id);

CREATE TRIGGER trg_agent_runs_updated_at
BEFORE UPDATE ON agent_runs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
