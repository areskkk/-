ALTER TABLE files
  ALTER COLUMN enterprise_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'enterprise_resource';

ALTER TABLE files
  ADD CONSTRAINT chk_files_purpose
  CHECK (purpose IN ('enterprise_resource', 'enterprise_binding'));

CREATE INDEX IF NOT EXISTS idx_files_uploader_purpose_created_at
ON files(uploader_user_id, purpose, created_at DESC);
