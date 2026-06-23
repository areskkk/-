ALTER TABLE applications
ALTER COLUMN profile_snapshot_id DROP NOT NULL;

CREATE INDEX idx_applications_enterprise_created_at ON applications(enterprise_id, created_at DESC);
CREATE INDEX idx_application_policy_items_application_id ON application_policy_items(application_id);
