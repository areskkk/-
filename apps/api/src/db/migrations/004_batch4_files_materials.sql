CREATE TABLE files (
  file_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL REFERENCES enterprises(enterprise_id),
  uploader_user_id uuid NOT NULL REFERENCES users(user_id),
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  file_hash text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_files_enterprise_created_at ON files(enterprise_id, created_at DESC);
CREATE INDEX idx_files_hash ON files(file_hash);
CREATE INDEX idx_files_uploader ON files(uploader_user_id);

ALTER TABLE materials
  ALTER COLUMN file_id TYPE uuid USING file_id::uuid;

ALTER TABLE materials
  ADD CONSTRAINT fk_materials_file
  FOREIGN KEY (file_id) REFERENCES files(file_id);

CREATE INDEX idx_materials_file_id ON materials(file_id);
