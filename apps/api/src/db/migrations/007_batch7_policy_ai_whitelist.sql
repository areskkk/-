CREATE TABLE IF NOT EXISTS policy_ai_whitelist (
  policy_id uuid PRIMARY KEY REFERENCES policies(policy_id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policy_ai_whitelist_enabled
ON policy_ai_whitelist(enabled);
