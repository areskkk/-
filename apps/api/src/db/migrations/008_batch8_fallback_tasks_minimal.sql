ALTER TABLE fallback_tasks
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS resolution_type text,
  ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES users(user_id),
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

UPDATE fallback_tasks
SET
  source_type = COALESCE(NULLIF(source_type, ''), 'legacy'),
  source_id = COALESCE(NULLIF(source_id, ''), run_id, task_id::text),
  context = COALESCE(context, '{}'::jsonb)
WHERE source_type IS NULL
  OR source_type = ''
  OR source_id IS NULL
  OR source_id = '';

ALTER TABLE fallback_tasks
  ALTER COLUMN source_type SET NOT NULL,
  ALTER COLUMN source_id SET NOT NULL,
  ALTER COLUMN context SET NOT NULL;

ALTER TABLE fallback_tasks
  ADD CONSTRAINT chk_fallback_source_non_empty
  CHECK (source_type <> '' AND source_id <> '');

ALTER TABLE fallback_tasks
  ADD CONSTRAINT chk_fallback_resolution_type
  CHECK (
    resolution_type IS NULL
    OR resolution_type IN ('answer', 'field_patch', 'material_confirm', 'close')
  );

CREATE INDEX IF NOT EXISTS idx_fallback_tasks_status_source_created
ON fallback_tasks(status, source_type, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fallback_tasks_pending_source_reason
ON fallback_tasks(source_type, source_id, reason)
WHERE status = 'pending';
