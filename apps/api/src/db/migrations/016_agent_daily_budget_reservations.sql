CREATE TABLE IF NOT EXISTS agent_daily_budget_reservations (
  reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  trace_id text,
  model_name text NOT NULL,
  reservation_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'reserved',
  reserved_tokens int NOT NULL DEFAULT 0,
  reserved_cost_cents numeric(12, 4) NOT NULL DEFAULT 0,
  actual_tokens int NOT NULL DEFAULT 0,
  actual_cost_cents numeric(12, 4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT chk_agent_daily_budget_reservations_status CHECK (
    status IN ('reserved', 'settled', 'released')
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_daily_budget_reservations_day_status
ON agent_daily_budget_reservations(reservation_date, status);

CREATE INDEX IF NOT EXISTS idx_agent_daily_budget_reservations_run
ON agent_daily_budget_reservations(run_id, created_at DESC);
