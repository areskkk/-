CREATE TABLE IF NOT EXISTS agent_ops_controls (
  control_key text PRIMARY KEY,
  control_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text NOT NULL DEFAULT 'system',
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_agent_ops_controls_updated_at
BEFORE UPDATE ON agent_ops_controls
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS agent_tool_health (
  tool_name text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count int NOT NULL DEFAULT 0,
  error_count int NOT NULL DEFAULT 0,
  latency_samples_ms jsonb NOT NULL DEFAULT '[]'::jsonb,
  circuit_open_until timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_agent_tool_health_updated_at
BEFORE UPDATE ON agent_tool_health
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS agent_run_replays (
  replay_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id uuid NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  replay_run_id uuid REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  actor_id text NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'created',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_agent_run_replays_status CHECK (
    status IN ('created', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_run_replays_source
ON agent_run_replays(source_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_run_replays_replay
ON agent_run_replays(replay_run_id)
WHERE replay_run_id IS NOT NULL;
