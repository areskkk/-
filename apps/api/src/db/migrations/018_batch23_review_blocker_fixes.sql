ALTER TABLE materials
  ADD COLUMN IF NOT EXISTS policy_item_id uuid REFERENCES application_policy_items(item_id);

UPDATE materials m
SET policy_item_id = api.item_id
FROM application_policy_items api
WHERE m.policy_item_id IS NULL
  AND api.application_id = m.application_id
  AND (
    SELECT COUNT(*)
    FROM application_policy_items count_api
    WHERE count_api.application_id = m.application_id
  ) = 1;

DROP INDEX IF EXISTS idx_materials_one_current_per_application_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_one_current_per_application_item_type
ON materials(application_id, COALESCE(policy_item_id, '00000000-0000-0000-0000-000000000000'::uuid), material_type)
WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_materials_application_item_current
ON materials(application_id, policy_item_id, is_current);
