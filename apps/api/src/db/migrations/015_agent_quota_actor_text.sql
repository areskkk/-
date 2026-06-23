ALTER TABLE agent_quota_reservations
  ALTER COLUMN actor_id TYPE text USING actor_id::text;
