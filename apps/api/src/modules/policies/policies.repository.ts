import { query, queryOne } from '../../db/query.js';

export type PolicyRow = {
  policy_id: string;
  title: string;
  department_id: string | null;
  source_type: string;
  source_name: string | null;
  source_url: string | null;
  status: string;
  version: string;
  effective_date: string | null;
  expire_date: string | null;
  content: string | null;
};

export type PolicyConditionInput = {
  field_key: string;
  operator: string;
  target_value: unknown;
  required: boolean;
  evidence_type: string;
  fail_action: string;
  message?: string;
  weight?: number;
};

export type PolicyMaterialRequirementInput = {
  material_type: string;
  required: boolean;
  validity_days?: number | null;
  template_url?: string | null;
  reuse_allowed_in_application?: boolean;
  ocr_fields?: string[];
};

export async function insertPolicy(input: {
  title: string;
  department_id?: string | null;
  source_type: string;
  source_name?: string | null;
  source_url?: string | null;
  version?: string;
  effective_date?: string | null;
  expire_date?: string | null;
  content?: string | null;
}): Promise<PolicyRow> {
  const policy = await queryOne<PolicyRow>(
    `
      INSERT INTO policies (
        title,
        department_id,
        source_type,
        source_name,
        source_url,
        version,
        effective_date,
        expire_date,
        content
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        policy_id,
        title,
        department_id,
        source_type,
        source_name,
        source_url,
        status,
        version,
        effective_date,
        expire_date,
        content
    `,
    [
      input.title,
      input.department_id ?? null,
      input.source_type,
      input.source_name ?? null,
      input.source_url ?? null,
      input.version ?? 'v1',
      input.effective_date ?? null,
      input.expire_date ?? null,
      input.content ?? null,
    ],
  );

  if (!policy) {
    throw new Error('Failed to insert policy');
  }

  return policy;
}

export async function listPolicies(input: {
  limit: number;
  offset: number;
  status?: string;
}) {
  return query<PolicyRow>(
    `
      SELECT
        policy_id,
        title,
        department_id,
        source_type,
        source_name,
        source_url,
        status,
        version,
        effective_date,
        expire_date,
        content
      FROM policies
      WHERE status = $3
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `,
    [input.limit, input.offset, input.status ?? 'effective'],
  );
}

export async function countPolicies(status = 'effective'): Promise<number> {
  const row = await queryOne<{ total: string }>(
    'SELECT COUNT(*)::text AS total FROM policies WHERE status = $1',
    [status],
  );
  return Number(row?.total ?? '0');
}

export async function findPolicyById(
  policyId: string,
  status?: string,
): Promise<PolicyRow | undefined> {
  if (status) {
    return queryOne<PolicyRow>(
      `
        SELECT
          policy_id,
          title,
          department_id,
          source_type,
          source_name,
          source_url,
          status,
          version,
          effective_date,
          expire_date,
          content
        FROM policies
        WHERE policy_id = $1
          AND status = $2::policy_status
      `,
      [policyId, status],
    );
  }

  return queryOne<PolicyRow>(
    `
      SELECT
        policy_id,
        title,
        department_id,
        source_type,
        source_name,
        source_url,
        status,
        version,
        effective_date,
        expire_date,
        content
      FROM policies
      WHERE policy_id = $1
    `,
    [policyId],
  );
}

export async function replacePolicySchema(input: {
  policy_id: string;
  conditions: PolicyConditionInput[];
  materials: PolicyMaterialRequirementInput[];
}) {
  await query('DELETE FROM policy_conditions WHERE policy_id = $1', [input.policy_id]);
  await query('DELETE FROM policy_material_requirements WHERE policy_id = $1', [input.policy_id]);

  for (const condition of input.conditions) {
    await query(
      `
        INSERT INTO policy_conditions (
          policy_id,
          field_key,
          operator,
          target_value,
          required,
          evidence_type,
          fail_action,
          message,
          weight
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
      `,
      [
        input.policy_id,
        condition.field_key,
        condition.operator,
        JSON.stringify(condition.target_value),
        condition.required,
        condition.evidence_type,
        condition.fail_action,
        condition.message ?? null,
        condition.weight ?? null,
      ],
    );
  }

  for (const material of input.materials) {
    await query(
      `
        INSERT INTO policy_material_requirements (
          policy_id,
          material_type,
          required,
          validity_days,
          template_url,
          reuse_allowed_in_application,
          ocr_fields
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [
        input.policy_id,
        material.material_type,
        material.required,
        material.validity_days ?? null,
        material.template_url ?? null,
        material.reuse_allowed_in_application ?? true,
        JSON.stringify(material.ocr_fields ?? []),
      ],
    );
  }
}

export async function updatePolicyStatus(policyId: string, status: string): Promise<void> {
  await query(
    `
      UPDATE policies
      SET status = $2
      WHERE policy_id = $1
    `,
    [policyId, status],
  );
}
