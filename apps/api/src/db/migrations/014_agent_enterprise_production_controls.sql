CREATE TABLE IF NOT EXISTS agent_quota_reservations (
  reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  enterprise_id uuid,
  reservation_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'active',
  reserved_tokens int NOT NULL DEFAULT 0,
  reserved_cost_cents numeric(12, 4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT chk_agent_quota_reservations_status CHECK (
    status IN ('active', 'released', 'cancelled')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_quota_reservations_run_active
ON agent_quota_reservations(run_id)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_agent_quota_reservations_actor_day
ON agent_quota_reservations(actor_id, reservation_date, status);

CREATE INDEX IF NOT EXISTS idx_agent_quota_reservations_enterprise_day
ON agent_quota_reservations(enterprise_id, reservation_date, status)
WHERE enterprise_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_model_prices (
  model_name text PRIMARY KEY,
  input_cents_per_1k numeric(12, 6) NOT NULL,
  output_cents_per_1k numeric(12, 6) NOT NULL,
  image_cents_per_unit numeric(12, 6) NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'env_or_default',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO agent_model_prices (model_name, input_cents_per_1k, output_cents_per_1k)
VALUES
  ('qwen3.6-plus', 0.020000, 0.060000),
  ('qwen3-vl-30b-a3b-thinking', 0.080000, 0.240000),
  ('glm-5', 0.030000, 0.090000),
  ('qwen-plus-2025-07-28', 0.020000, 0.060000),
  ('qwen-math-turbo', 0.030000, 0.090000),
  ('qwen3-vl-235b-a22b-thinking', 0.120000, 0.360000),
  ('deepseek-r1-distill-qwen-7b', 0.010000, 0.030000)
ON CONFLICT (model_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS agent_llm_calls (
  llm_call_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  trace_id text,
  agent_type text,
  model_name text NOT NULL,
  prompt_version text,
  status text NOT NULL,
  token_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimated_cost_cents numeric(12, 4) NOT NULL DEFAULT 0,
  latency_ms int,
  error_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_agent_llm_calls_status CHECK (
    status IN ('completed', 'failed', 'blocked')
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_llm_calls_run
ON agent_llm_calls(run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_llm_calls_model
ON agent_llm_calls(model_name, created_at DESC);

CREATE OR REPLACE VIEW agent_run_observability AS
SELECT
  r.run_id::text,
  r.actor_id::text,
  r.entrypoint,
  r.status,
  r.current_node,
  r.trace_id,
  r.started_at,
  r.updated_at,
  r.completed_at,
  COALESCE(step_stats.step_count, 0) AS step_count,
  COALESCE(tool_stats.tool_call_count, 0) AS tool_call_count,
  COALESCE(llm_stats.llm_call_count, 0) AS llm_call_count,
  COALESCE(llm_stats.total_tokens, 0) AS total_tokens,
  COALESCE(llm_stats.estimated_cost_cents, 0) AS estimated_cost_cents,
  r.error_message
FROM agent_runs r
LEFT JOIN LATERAL (
  SELECT count(*)::int AS step_count
  FROM agent_run_steps s
  WHERE s.run_id = r.run_id
) step_stats ON true
LEFT JOIN LATERAL (
  SELECT count(*)::int AS tool_call_count
  FROM agent_tool_calls t
  WHERE t.run_id = r.run_id
) tool_stats ON true
LEFT JOIN LATERAL (
  SELECT
    count(*)::int AS llm_call_count,
    COALESCE(sum((c.token_usage->>'total_tokens')::int), 0)::int AS total_tokens,
    COALESCE(sum(c.estimated_cost_cents), 0)::numeric(12, 4) AS estimated_cost_cents
  FROM agent_llm_calls c
  WHERE c.run_id = r.run_id
) llm_stats ON true;
