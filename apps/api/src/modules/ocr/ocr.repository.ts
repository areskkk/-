import { query, queryOne } from '../../db/query.js';

export type OcrResultRow = {
  ocr_result_id: string;
  material_id: string;
  material_type: string | null;
  fields: Record<string, unknown>;
  field_confidence: Record<string, number>;
  overall_confidence: string | null;
  warnings: string[];
  requires_manual_confirmation: boolean;
  created_at: string;
};

export type MaterialForOcrRow = {
  material_id: string;
  application_id: string;
  enterprise_id: string;
  material_type: string;
  file_id: string;
  mime_type: string;
  original_filename: string;
  storage_key: string;
  is_current: boolean;
  ocr_status: string;
};

export async function insertOcrResult(input: {
  material_id: string;
  material_type: string;
  fields: Record<string, unknown>;
  field_confidence: Record<string, number>;
  overall_confidence: number;
  warnings: string[];
  requires_manual_confirmation: boolean;
}): Promise<OcrResultRow> {
  const row = await queryOne<OcrResultRow>(
    `
      INSERT INTO ocr_results (
        material_id,
        material_type,
        fields,
        field_confidence,
        overall_confidence,
        warnings,
        requires_manual_confirmation
      )
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7)
      RETURNING
        ocr_result_id::text,
        material_id::text,
        material_type,
        fields,
        field_confidence,
        overall_confidence::text,
        warnings,
        requires_manual_confirmation,
        created_at::text
    `,
    [
      input.material_id,
      input.material_type,
      JSON.stringify(input.fields),
      JSON.stringify(input.field_confidence),
      input.overall_confidence,
      JSON.stringify(input.warnings),
      input.requires_manual_confirmation,
    ],
  );

  if (!row) {
    throw new Error('Failed to create OCR result');
  }

  return row;
}

export async function updateMaterialOcrStatus(input: {
  material_id: string;
  ocr_status: 'pending' | 'success' | 'low_confidence' | 'failed';
}): Promise<void> {
  await queryOne(
    `
      UPDATE materials
      SET ocr_status = $2
      WHERE material_id = $1
      RETURNING material_id::text
    `,
    [input.material_id, input.ocr_status],
  );
}

export async function findLatestOcrResultByMaterialId(
  materialId: string,
): Promise<OcrResultRow | undefined> {
  // Batch 6 API contract: GET /materials/:material_id/ocr returns the latest
  // OCR result only, using stable ordering for records created at the same time.
  return queryOne<OcrResultRow>(
    `
      SELECT
        ocr_result_id::text,
        material_id::text,
        material_type,
        fields,
        field_confidence,
        overall_confidence::text,
        warnings,
        requires_manual_confirmation,
        created_at::text
      FROM ocr_results
      WHERE material_id = $1
      ORDER BY created_at DESC, ocr_result_id DESC
      LIMIT 1
    `,
    [materialId],
  );
}

export async function findMaterialForOcrById(
  materialId: string,
): Promise<MaterialForOcrRow | undefined> {
  return queryOne<MaterialForOcrRow>(
    `
      SELECT
        m.material_id::text,
        m.application_id::text,
        a.enterprise_id::text,
        m.material_type,
        m.file_id::text,
        f.mime_type,
        f.original_filename,
        f.storage_key,
        m.is_current,
        m.ocr_status::text
      FROM materials m
      INNER JOIN applications a ON a.application_id = m.application_id
      INNER JOIN files f ON f.file_id = m.file_id
      WHERE m.material_id = $1
    `,
    [materialId],
  );
}
