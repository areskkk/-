import { query, queryOne } from '../../db/query.js';

export type EligiblePolicyRow = {
  policy_id: string;
  title: string;
  version: string;
  status: string;
  source_name: string | null;
  source_url: string | null;
  content: string | null;
};

export type PolicyConditionRow = {
  condition_id: string;
  field_key: string;
  operator: string;
  target_value: unknown;
  required: boolean;
  evidence_type: string;
  fail_action: 'eligible' | 'ineligible' | 'need_info' | 'manual_review';
  message: string | null;
};

export type ApplicationPolicyEvidenceRow = {
  application_id: string;
  enterprise_id: string;
  policy_item_count: string;
  policy_id: string;
};

export type MaterialEvidenceRow = {
  material_id: string;
  application_id: string;
  policy_item_id: string | null;
  material_type: string;
  file_id: string;
  issue_date: string | null;
  expire_date: string | null;
  ocr_status: string;
  ocr_result_id: string | null;
  ocr_fields: Record<string, unknown> | null;
  field_confidence: Record<string, number> | null;
  overall_confidence: string | null;
  warnings: string[] | null;
  requires_manual_confirmation: boolean | null;
};

export async function findWhitelistedEffectivePolicy(
  policyId: string,
): Promise<EligiblePolicyRow | undefined> {
  return queryOne<EligiblePolicyRow>(
    `
      SELECT
        p.policy_id::text,
        p.title,
        p.version,
        p.status::text,
        p.source_name,
        p.source_url,
        p.content
      FROM policies p
      INNER JOIN policy_ai_whitelist w ON w.policy_id = p.policy_id
      WHERE p.policy_id = $1
        AND p.status = 'effective'
        AND w.enabled = true
    `,
    [policyId],
  );
}

export async function listPolicyConditions(
  policyId: string,
): Promise<PolicyConditionRow[]> {
  return query<PolicyConditionRow>(
    `
      SELECT
        condition_id::text,
        field_key,
        operator,
        target_value,
        required,
        evidence_type,
        fail_action,
        message
      FROM policy_conditions
      WHERE policy_id = $1
      ORDER BY created_at ASC, condition_id ASC
    `,
    [policyId],
  );
}

export async function findApplicationPolicyEvidence(
  applicationId: string,
  itemId?: string,
): Promise<ApplicationPolicyEvidenceRow | undefined> {
  return queryOne<ApplicationPolicyEvidenceRow>(
    `
      SELECT
        a.application_id::text,
        a.enterprise_id::text,
        COUNT(api.item_id)::text AS policy_item_count,
        MIN(api.policy_id::text) AS policy_id
      FROM applications a
      INNER JOIN application_policy_items api ON api.application_id = a.application_id
      WHERE a.application_id = $1
        AND ($2::uuid IS NULL OR api.item_id = $2::uuid)
      GROUP BY a.application_id, a.enterprise_id
    `,
    [applicationId, itemId ?? null],
  );
}

export async function findApplicationPolicyEvidenceByPolicyId(input: {
  application_id: string;
  policy_id: string;
}): Promise<ApplicationPolicyEvidenceRow | undefined> {
  return queryOne<ApplicationPolicyEvidenceRow>(
    `
      SELECT
        a.application_id::text,
        a.enterprise_id::text,
        COUNT(api.item_id) OVER (PARTITION BY a.application_id)::text AS policy_item_count,
        api.policy_id::text
      FROM applications a
      INNER JOIN application_policy_items api ON api.application_id = a.application_id
      WHERE a.application_id = $1
        AND api.policy_id = $2
      LIMIT 1
    `,
    [input.application_id, input.policy_id],
  );
}

export async function findApplicationPolicyItemIdByPolicyId(input: {
  application_id: string;
  policy_id: string;
}): Promise<string | undefined> {
  const row = await queryOne<{ item_id: string }>(
    `
      SELECT item_id::text
      FROM application_policy_items
      WHERE application_id = $1
        AND policy_id = $2
      LIMIT 1
    `,
    [input.application_id, input.policy_id],
  );
  return row?.item_id;
}

export async function listMaterialEvidenceByApplicationId(input: {
  applicationId: string;
  itemId?: string;
}): Promise<MaterialEvidenceRow[]> {
  return query<MaterialEvidenceRow>(
    `
      SELECT
        m.material_id::text,
        m.application_id::text,
        m.policy_item_id::text,
        m.material_type,
        m.file_id::text,
        m.issue_date::text,
        m.expire_date::text,
        m.ocr_status::text,
        o.ocr_result_id::text,
        o.fields AS ocr_fields,
        o.field_confidence,
        o.overall_confidence::text,
        o.warnings,
        o.requires_manual_confirmation
      FROM materials m
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
        AND ($2::uuid IS NULL OR m.policy_item_id = $2)
        AND m.is_current = true
      ORDER BY m.created_at ASC
    `,
    [input.applicationId, input.itemId ?? null],
  );
}
