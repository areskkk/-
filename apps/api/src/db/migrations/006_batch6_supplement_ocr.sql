ALTER TABLE materials
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS replaced_by_material_id uuid REFERENCES materials(material_id),
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

WITH ranked AS (
  SELECT
    material_id,
    row_number() OVER (
      PARTITION BY application_id, material_type
      ORDER BY created_at DESC, material_id DESC
    ) AS rn
  FROM materials
  WHERE is_current = true
)
UPDATE materials m
SET
  is_current = false,
  superseded_at = COALESCE(m.superseded_at, now())
FROM ranked r
WHERE m.material_id = r.material_id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_one_current_per_application_type
ON materials(application_id, material_type)
WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_materials_application_current
ON materials(application_id, is_current);

ALTER TABLE ocr_results
  ADD COLUMN IF NOT EXISTS material_type text,
  ADD COLUMN IF NOT EXISTS warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS requires_manual_confirmation boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ocr_results_material_created_at
ON ocr_results(material_id, created_at DESC);
