import {
  query,
  queryOne,
  type DbTransaction,
} from '../../db/query.js';

export type EnterpriseRow = {
  enterprise_id: string;
  name: string;
  credit_code: string;
  status: string;
};

export type EnterpriseAccountRow = {
  account_id: string;
  enterprise_id: string;
  user_id: string;
  role: string;
  auth_status: string;
};

export type EnterpriseListRow = {
  enterprise_id: string;
  enterprise_name: string;
  credit_code: string;
  role: string;
  auth_status: string;
};

export type BusinessLicenseOcrRow = {
  material_id: string;
  material_type: string;
  ocr_status: string;
  fields: Record<string, unknown>;
  field_confidence: Record<string, number>;
  overall_confidence: string | null;
  warnings: string[] | null;
  requires_manual_confirmation: boolean;
};

export async function findEnterpriseByCreditCode(
  creditCode: string,
): Promise<EnterpriseRow | undefined> {
  return queryOne<EnterpriseRow>(
    `
      SELECT enterprise_id, name, credit_code, status
      FROM enterprises
      WHERE credit_code = $1
    `,
    [creditCode],
  );
}

export async function insertEnterprise(input: {
  name: string;
  credit_code: string;
  status: string;
}): Promise<EnterpriseRow> {
  const enterprise = await queryOne<EnterpriseRow>(
    `
      INSERT INTO enterprises (name, credit_code, status)
      VALUES ($1, $2, $3)
      RETURNING enterprise_id, name, credit_code, status
    `,
    [input.name, input.credit_code, input.status],
  );

  if (!enterprise) {
    throw new Error('Failed to create enterprise');
  }

  return enterprise;
}

export async function findEnterpriseByCreditCodeInTransaction(
  tx: DbTransaction,
  creditCode: string,
): Promise<EnterpriseRow | undefined> {
  return tx.queryOne<EnterpriseRow>(
    `
      SELECT enterprise_id::text, name, credit_code, status::text AS status
      FROM enterprises
      WHERE credit_code = $1
      FOR UPDATE
    `,
    [creditCode],
  );
}

export async function insertEnterpriseInTransaction(
  tx: DbTransaction,
  input: {
    name: string;
    credit_code: string;
    status: string;
  },
): Promise<EnterpriseRow> {
  const enterprise = await tx.queryOne<EnterpriseRow>(
    `
      INSERT INTO enterprises (name, credit_code, status)
      VALUES ($1, $2, $3)
      RETURNING enterprise_id::text, name, credit_code, status::text AS status
    `,
    [input.name, input.credit_code, input.status],
  );

  if (!enterprise) {
    throw new Error('Failed to create enterprise');
  }

  return enterprise;
}

export async function insertEnterpriseAccount(input: {
  enterprise_id: string;
  user_id: string;
  role: string;
  auth_status: string;
}): Promise<EnterpriseAccountRow> {
  const account = await queryOne<EnterpriseAccountRow>(
    `
      INSERT INTO enterprise_accounts (enterprise_id, user_id, role, auth_status)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (enterprise_id, user_id)
      DO UPDATE SET role = EXCLUDED.role, auth_status = EXCLUDED.auth_status
      RETURNING account_id, enterprise_id, user_id, role, auth_status
    `,
    [input.enterprise_id, input.user_id, input.role, input.auth_status],
  );

  if (!account) {
    throw new Error('Failed to create enterprise account');
  }

  return account;
}

export async function upsertEnterpriseAccountPreservingTerminalInTransaction(
  tx: DbTransaction,
  input: {
    enterprise_id: string;
    user_id: string;
    role: string;
    auth_status: string;
  },
): Promise<EnterpriseAccountRow> {
  const account = await tx.queryOne<EnterpriseAccountRow>(
    `
      INSERT INTO enterprise_accounts (enterprise_id, user_id, role, auth_status)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (enterprise_id, user_id)
      DO UPDATE SET
        role = CASE
          WHEN enterprise_accounts.auth_status IN (
            'agent_approved',
            'manual_approved',
            'rejected',
            'revoked'
          ) THEN enterprise_accounts.role
          ELSE EXCLUDED.role
        END,
        auth_status = CASE
          WHEN enterprise_accounts.auth_status IN (
            'agent_approved',
            'manual_approved',
            'rejected',
            'revoked'
          ) THEN enterprise_accounts.auth_status
          ELSE EXCLUDED.auth_status
        END
      RETURNING
        account_id::text,
        enterprise_id::text,
        user_id::text,
        role,
        auth_status::text
    `,
    [input.enterprise_id, input.user_id, input.role, input.auth_status],
  );

  if (!account) {
    throw new Error('Failed to create enterprise account');
  }

  return account;
}

export async function findEnterprisesByUserId(userId: string): Promise<EnterpriseListRow[]> {
  return query<EnterpriseListRow>(
    `
      SELECT
        e.enterprise_id,
        e.name AS enterprise_name,
        e.credit_code,
        ea.role,
        ea.auth_status
      FROM enterprise_accounts ea
      INNER JOIN enterprises e ON e.enterprise_id = ea.enterprise_id
      WHERE ea.user_id = $1
      ORDER BY e.created_at DESC
    `,
    [userId],
  );
}

export async function findApprovedEnterprisesByUserId(
  userId: string,
): Promise<EnterpriseListRow[]> {
  return query<EnterpriseListRow>(
    `
      SELECT
        e.enterprise_id::text,
        e.name AS enterprise_name,
        e.credit_code,
        ea.role,
        ea.auth_status
      FROM enterprise_accounts ea
      INNER JOIN enterprises e ON e.enterprise_id = ea.enterprise_id
      WHERE ea.user_id = $1
        AND ea.auth_status IN ('agent_approved', 'manual_approved')
      ORDER BY e.created_at DESC
    `,
    [userId],
  );
}

export async function findLatestBusinessLicenseOcrByFileId(
  fileId: string,
): Promise<BusinessLicenseOcrRow | undefined> {
  return queryOne<BusinessLicenseOcrRow>(
    `
      SELECT
        m.material_id::text,
        m.material_type,
        m.ocr_status::text,
        o.fields,
        o.field_confidence,
        o.overall_confidence::text,
        o.warnings,
        o.requires_manual_confirmation
      FROM materials m
      INNER JOIN ocr_results o ON o.material_id = m.material_id
      WHERE m.file_id = $1
        AND m.material_type = 'business_license'
      ORDER BY o.created_at DESC, o.ocr_result_id DESC
      LIMIT 1
    `,
    [fileId],
  );
}
