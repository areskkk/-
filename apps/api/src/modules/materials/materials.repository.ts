import { query, queryOne } from '../../db/query.js';

export type MaterialRow = {
  material_id: string;
  application_id: string;
  policy_item_id: string | null;
  material_type: string;
  file_id: string;
  file_hash: string;
  issue_date: string | null;
  expire_date: string | null;
  ocr_status: string;
  security_level: string;
  is_current: boolean;
  replaced_by_material_id: string | null;
  superseded_at: string | null;
  created_at: string;
};

export type MaterialWithFileRow = MaterialRow & {
  original_filename: string;
  mime_type: string;
  byte_size: string;
  ocr_result_id: string | null;
  ocr_fields: Record<string, unknown> | null;
  field_confidence: Record<string, number> | null;
  overall_confidence: string | null;
  warnings: string[] | null;
  requires_manual_confirmation: boolean | null;
};

export async function insertMaterial(input: {
  application_id: string;
  policy_item_id?: string | null;
  material_type: string;
  file_id: string;
  file_hash: string;
  issue_date?: string | null;
  expire_date?: string | null;
  security_level?: string;
}): Promise<MaterialRow> {
  const material = await queryOne<MaterialRow>(
    `
      INSERT INTO materials (
        application_id,
        policy_item_id,
        material_type,
        file_id,
        file_hash,
        issue_date,
        expire_date,
        security_level
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        material_id,
        application_id,
        policy_item_id::text,
        material_type,
        file_id::text,
        file_hash,
        issue_date::text,
        expire_date::text,
        ocr_status,
        security_level,
        is_current,
        replaced_by_material_id::text,
        superseded_at::text,
        created_at::text
    `,
    [
      input.application_id,
      input.policy_item_id ?? null,
      input.material_type,
      input.file_id,
      input.file_hash,
      input.issue_date ?? null,
      input.expire_date ?? null,
      input.security_level ?? 'L3',
    ],
  );

  if (!material) {
    throw new Error('Failed to create material');
  }

  return material;
}

export async function listMaterialsByApplicationId(
  applicationId: string,
): Promise<MaterialWithFileRow[]> {
  return query<MaterialWithFileRow>(
    `
      SELECT
        m.material_id,
        m.application_id,
        m.policy_item_id::text,
        m.material_type,
        m.file_id::text,
        m.file_hash,
        m.issue_date::text,
        m.expire_date::text,
        m.ocr_status,
        m.security_level,
        m.is_current,
        m.replaced_by_material_id::text,
        m.superseded_at::text,
        m.created_at::text,
        f.original_filename,
        f.mime_type,
        f.byte_size::text,
        o.ocr_result_id::text,
        o.fields AS ocr_fields,
        o.field_confidence,
        o.overall_confidence::text,
        o.warnings,
        o.requires_manual_confirmation
      FROM materials m
      INNER JOIN files f ON f.file_id = m.file_id
      LEFT JOIN LATERAL (
        SELECT
          ocr_result_id,
          fields,
          field_confidence,
          overall_confidence,
          warnings,
          requires_manual_confirmation
        FROM ocr_results
        WHERE material_id = m.material_id
        ORDER BY created_at DESC, ocr_result_id DESC
        LIMIT 1
      ) o ON true
      WHERE m.application_id = $1
        AND m.is_current = true
      ORDER BY m.created_at ASC
    `,
    [applicationId],
  );
}
