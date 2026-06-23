import {
  queryOne,
  withTransaction,
  type DbTransaction,
} from '../../db/query.js';

export type EnterpriseProfileCurrentRow = {
  profile_id: string;
  enterprise_id: string;
  enterprise_name: string;
  credit_code: string;
  industry: string | null;
  scale: string | null;
  revenue_amount: string | null;
  employee_count: number | null;
  tax_amount: string | null;
  export_amount: string | null;
  tech_upgrade_status: string | null;
  source: string;
  profile_json: Record<string, unknown>;
};

export async function getCurrentProfileByEnterpriseId(
  enterpriseId: string,
): Promise<EnterpriseProfileCurrentRow | undefined> {
  return queryOne<EnterpriseProfileCurrentRow>(
    `
      SELECT
        profile_id,
        enterprise_id,
        enterprise_name,
        credit_code,
        industry,
        scale,
        revenue_amount,
        employee_count,
        tax_amount,
        export_amount,
        tech_upgrade_status,
        source,
        profile_json
      FROM enterprise_profiles
      WHERE enterprise_id = $1
    `,
    [enterpriseId],
  );
}

export async function upsertCurrentProfile(input: {
  enterprise_id: string;
  enterprise_name: string;
  credit_code: string;
  industry?: string;
  scale?: string;
  revenue_amount?: number;
  employee_count?: number;
  tax_amount?: number;
  export_amount?: number;
  tech_upgrade_status?: string;
  source?: string;
  profile_json?: Record<string, unknown>;
}): Promise<EnterpriseProfileCurrentRow> {
  const profile = await queryOne<EnterpriseProfileCurrentRow>(
    `
      INSERT INTO enterprise_profiles (
        enterprise_id,
        enterprise_name,
        credit_code,
        industry,
        scale,
        revenue_amount,
        employee_count,
        tax_amount,
        export_amount,
        tech_upgrade_status,
        source,
        profile_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
      ON CONFLICT (enterprise_id)
      DO UPDATE SET
        enterprise_name = EXCLUDED.enterprise_name,
        credit_code = EXCLUDED.credit_code,
        industry = EXCLUDED.industry,
        scale = EXCLUDED.scale,
        revenue_amount = EXCLUDED.revenue_amount,
        employee_count = EXCLUDED.employee_count,
        tax_amount = EXCLUDED.tax_amount,
        export_amount = EXCLUDED.export_amount,
        tech_upgrade_status = EXCLUDED.tech_upgrade_status,
        source = EXCLUDED.source,
        profile_json = EXCLUDED.profile_json
      RETURNING
        profile_id,
        enterprise_id,
        enterprise_name,
        credit_code,
        industry,
        scale,
        revenue_amount,
        employee_count,
        tax_amount,
        export_amount,
        tech_upgrade_status,
        source,
        profile_json
    `,
    [
      input.enterprise_id,
      input.enterprise_name,
      input.credit_code,
      input.industry ?? null,
      input.scale ?? null,
      input.revenue_amount ?? null,
      input.employee_count ?? null,
      input.tax_amount ?? null,
      input.export_amount ?? null,
      input.tech_upgrade_status ?? null,
      input.source ?? 'manual',
      JSON.stringify(input.profile_json ?? {}),
    ],
  );

  if (!profile) {
    throw new Error('Failed to upsert enterprise profile');
  }

  return profile;
}

export type EnterpriseProfileImportRow = {
  enterprise_name: string;
  credit_code: string;
  industry?: string | null;
  scale?: string | null;
  revenue_amount?: number | null;
  employee_count?: number | null;
  tax_amount?: number | null;
  export_amount?: number | null;
  tech_upgrade_status?: string | null;
  source?: string | null;
  profile_json?: Record<string, unknown>;
};

export type EnterpriseProfileImportResult = {
  enterprise_id: string;
  profile_id: string;
  profile_existed: boolean;
};

export async function importEnterpriseProfilesInTransaction(
  rows: EnterpriseProfileImportRow[],
): Promise<EnterpriseProfileImportResult[]> {
  return withTransaction(async (tx: DbTransaction) => {
    const results: EnterpriseProfileImportResult[] = [];
    for (const row of rows) {
      const imported = await tx.queryOne<EnterpriseProfileImportResult>(
        `
          WITH enterprise_row AS (
            INSERT INTO enterprises (name, credit_code, status)
            VALUES ($1, $2, 'active')
            ON CONFLICT (credit_code)
            DO UPDATE SET name = EXCLUDED.name
            RETURNING enterprise_id::text
          ),
          existing_profile AS (
            SELECT profile_id
            FROM enterprise_profiles
            WHERE enterprise_id = (SELECT enterprise_id::uuid FROM enterprise_row)
          )
          INSERT INTO enterprise_profiles (
            enterprise_id,
            enterprise_name,
            credit_code,
            industry,
            scale,
            revenue_amount,
            employee_count,
            tax_amount,
            export_amount,
            tech_upgrade_status,
            source,
            profile_json
          )
          VALUES (
            (SELECT enterprise_id::uuid FROM enterprise_row),
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11::jsonb
          )
          ON CONFLICT (enterprise_id)
          DO UPDATE SET
            enterprise_name = EXCLUDED.enterprise_name,
            credit_code = EXCLUDED.credit_code,
            industry = EXCLUDED.industry,
            scale = EXCLUDED.scale,
            revenue_amount = EXCLUDED.revenue_amount,
            employee_count = EXCLUDED.employee_count,
            tax_amount = EXCLUDED.tax_amount,
            export_amount = EXCLUDED.export_amount,
            tech_upgrade_status = EXCLUDED.tech_upgrade_status,
            source = EXCLUDED.source,
            profile_json = EXCLUDED.profile_json
          RETURNING
            enterprise_id::text,
            profile_id::text,
            EXISTS(SELECT 1 FROM existing_profile) AS profile_existed
        `,
        [
          row.enterprise_name,
          row.credit_code,
          row.industry ?? null,
          row.scale ?? null,
          row.revenue_amount ?? null,
          row.employee_count ?? null,
          row.tax_amount ?? null,
          row.export_amount ?? null,
          row.tech_upgrade_status ?? null,
          row.source ?? 'government_import',
          JSON.stringify(row.profile_json ?? {}),
        ],
      );

      if (!imported) {
        throw new Error('Failed to import enterprise profile');
      }
      results.push(imported);
    }
    return results;
  });
}
