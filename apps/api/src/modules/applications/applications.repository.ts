import {
  query,
  queryOne,
  withTransaction,
  type DbTransaction,
} from '../../db/query.js';
import { ApiError } from '../../common/errors/http-error.js';
import { aggregateApplicationStatusInTransaction } from './application-status.repository.js';

export type ApplicationRow = {
  application_id: string;
  enterprise_id: string;
  applicant_user_id: string;
  profile_snapshot_id: string | null;
  status: string;
  submit_time: string | null;
  deadline_at: string | null;
  created_at: string;
};

export type ApplicationPolicyItemRow = {
  item_id: string;
  application_id: string;
  policy_id: string;
  status: string;
  eligibility_result: string | null;
  current_department_id: string | null;
  review_result: string | null;
};

export type LatestSupplementRequestRow = {
  record_id: string;
  item_id: string;
  comment: string | null;
  created_at: string;
};

export type ApplicationDetailRow = ApplicationRow & {
  policy_id: string;
  policy_item_id: string;
  policy_item_status: string;
  policy_item_review_result: string | null;
};

export type ApplicationSummaryRow = ApplicationRow & {
  policy_items: Array<{
    item_id: string;
    policy_id: string;
    status: string;
    review_result: string | null;
  }>;
};

export type SupplementMaterialInput = {
  material_type: string;
  file_id: string;
  file_hash: string;
  mode: 'append' | 'replace';
  issue_date?: string | null;
  expire_date?: string | null;
  security_level?: string | null;
};

export type SupplementMaterialResult = {
  material_id: string;
  material_type: string;
  file_id: string;
  mode: 'append' | 'replace';
  replaced_material_id: string | null;
};

export async function insertApplication(input: {
  enterprise_id: string;
  applicant_user_id: string;
  status: string;
}): Promise<ApplicationRow> {
  const application = await queryOne<ApplicationRow>(
    `
      INSERT INTO applications (
        enterprise_id,
        applicant_user_id,
        status
      )
      VALUES ($1, $2, $3)
      RETURNING
        application_id,
        enterprise_id,
        applicant_user_id,
        profile_snapshot_id,
        status,
        submit_time::text,
        deadline_at::text,
        created_at::text
    `,
    [input.enterprise_id, input.applicant_user_id, input.status],
  );

  if (!application) {
    throw new Error('Failed to create application');
  }

  return application;
}

export async function insertApplicationPolicyItems(input: {
  application_id: string;
  policy_ids: string[];
  status: string;
}): Promise<ApplicationPolicyItemRow[]> {
  const items: ApplicationPolicyItemRow[] = [];
  for (const policyId of input.policy_ids) {
    items.push(await insertApplicationPolicyItem({
      application_id: input.application_id,
      policy_id: policyId,
      status: input.status,
    }));
  }
  return items;
}

export async function insertApplicationPolicyItem(input: {
  application_id: string;
  policy_id: string;
  status: string;
}): Promise<ApplicationPolicyItemRow> {
  const item = await queryOne<ApplicationPolicyItemRow>(
    `
      INSERT INTO application_policy_items (
        application_id,
        policy_id,
        status
      )
      VALUES ($1, $2, $3)
      RETURNING
        item_id,
        application_id,
        policy_id,
        status,
        eligibility_result,
        current_department_id,
        review_result
    `,
    [input.application_id, input.policy_id, input.status],
  );

  if (!item) {
    throw new Error('Failed to create application policy item');
  }

  return item;
}

export async function listApplicationsByEnterpriseId(input: {
  enterprise_id: string;
  limit: number;
  offset: number;
}): Promise<ApplicationSummaryRow[]> {
  return query<ApplicationSummaryRow>(
    `
      SELECT
        a.application_id::text,
        a.enterprise_id::text,
        a.applicant_user_id::text,
        a.profile_snapshot_id::text,
        a.status::text,
        a.submit_time::text,
        a.deadline_at::text,
        a.created_at::text,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'item_id', api.item_id::text,
              'policy_id', api.policy_id::text,
              'status', api.status::text,
              'review_result', api.review_result
            )
            ORDER BY api.created_at ASC, api.item_id ASC
          ) FILTER (WHERE api.item_id IS NOT NULL),
          '[]'::jsonb
        ) AS policy_items
      FROM applications a
      LEFT JOIN application_policy_items api ON api.application_id = a.application_id
      WHERE a.enterprise_id = $1
      GROUP BY a.application_id
      ORDER BY a.created_at DESC
      LIMIT $2 OFFSET $3
    `,
    [input.enterprise_id, input.limit, input.offset],
  );
}

export async function countApplicationsByEnterpriseId(
  enterpriseId: string,
): Promise<number> {
  const row = await queryOne<{ total: string }>(
    'SELECT COUNT(*)::text AS total FROM applications WHERE enterprise_id = $1',
    [enterpriseId],
  );
  return Number(row?.total ?? '0');
}

export async function findApplicationDetailById(
  applicationId: string,
): Promise<ApplicationDetailRow[]> {
  return query<ApplicationDetailRow>(
    `
      SELECT
        a.application_id,
        a.enterprise_id,
        a.applicant_user_id,
        a.profile_snapshot_id,
        a.status,
        a.submit_time::text,
        a.deadline_at::text,
        a.created_at::text,
        api.policy_id,
        api.item_id AS policy_item_id,
        api.status AS policy_item_status,
        api.review_result AS policy_item_review_result
      FROM applications a
      INNER JOIN application_policy_items api ON api.application_id = a.application_id
      WHERE a.application_id = $1
      ORDER BY api.created_at ASC
    `,
    [applicationId],
  );
}

export async function findLatestSupplementRequestByItemId(
  itemId: string,
): Promise<LatestSupplementRequestRow | undefined> {
  // Batch 6 supplement reason rule: read only the latest request_supplement
  // record for the current single policy item, with stable tie-breaking.
  return queryOne<LatestSupplementRequestRow>(
    `
      SELECT
        record_id::text,
        item_id::text,
        comment,
        created_at::text
      FROM review_records
      WHERE item_id = $1
        AND action = 'request_supplement'
      ORDER BY created_at DESC, record_id DESC
      LIMIT 1
    `,
    [itemId],
  );
}

export async function listLatestSupplementRequestsByApplicationId(
  applicationId: string,
): Promise<LatestSupplementRequestRow[]> {
  return query<LatestSupplementRequestRow>(
    `
      SELECT DISTINCT ON (item_id)
        record_id::text,
        item_id::text,
        comment,
        created_at::text
      FROM review_records
      WHERE application_id = $1
        AND action = 'request_supplement'
      ORDER BY item_id, created_at DESC, record_id DESC
    `,
    [applicationId],
  );
}

export async function submitSupplementInTransaction(input: {
  application_id: string;
  policy_item_id: string;
  materials: SupplementMaterialInput[];
}): Promise<{
  application_status: string;
  policy_item_status: string;
  policy_item_review_result: string | null;
  materials: SupplementMaterialResult[];
}> {
  return withTransaction(async (tx: DbTransaction) => {
    const materialResults: SupplementMaterialResult[] = [];

    for (const material of input.materials) {
      const current = await tx.query<{
        material_id: string;
      }>(
        `
          SELECT material_id::text
          FROM materials
          WHERE application_id = $1
            AND policy_item_id = $2
            AND material_type = $3
            AND is_current = true
          ORDER BY created_at DESC, material_id DESC
        `,
        [input.application_id, input.policy_item_id, material.material_type],
      );

      if (material.mode === 'append' && current.length > 0) {
        throw new Error(`current material already exists for ${material.material_type}`);
      }

      if (material.mode === 'replace' && current.length !== 1) {
        throw new Error(
          `replace requires exactly one current material for ${material.material_type}`,
        );
      }

      const inserted = await tx.queryOne<{
        material_id: string;
        material_type: string;
        file_id: string;
      }>(
        `
          INSERT INTO materials (
            application_id,
            policy_item_id,
            material_type,
            file_id,
            file_hash,
            issue_date,
            expire_date,
            security_level,
            is_current
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING
            material_id::text,
            material_type,
            file_id::text
        `,
        [
          input.application_id,
          input.policy_item_id,
          material.material_type,
          material.file_id,
          material.file_hash,
          material.issue_date ?? null,
          material.expire_date ?? null,
          material.security_level ?? 'L3',
          material.mode === 'append',
        ],
      );

      if (!inserted) {
        throw new Error('Failed to insert supplement material');
      }

      const currentMaterial = current[0];
      if (material.mode === 'replace' && currentMaterial) {
        await tx.execute(
          `
            UPDATE materials
            SET
              is_current = false,
              replaced_by_material_id = $2,
              superseded_at = now()
            WHERE material_id = $1
          `,
          [currentMaterial.material_id, inserted.material_id],
        );

        await tx.execute(
          `
            UPDATE materials
            SET is_current = true
            WHERE material_id = $1
          `,
          [inserted.material_id],
        );
      }

      materialResults.push({
        material_id: inserted.material_id,
        material_type: inserted.material_type,
        file_id: inserted.file_id,
        mode: material.mode,
        replaced_material_id: currentMaterial?.material_id ?? null,
      });
    }

    const item = await tx.queryOne<{
      status: string;
      review_result: string | null;
    }>(
      `
        UPDATE application_policy_items
        SET
          status = 'resubmitted',
          review_result = NULL
        WHERE item_id = $1
          AND application_id = $2
          AND status = 'need_supplement'
        RETURNING status::text, review_result
      `,
      [input.policy_item_id, input.application_id],
    );

    if (!item) {
      throw new ApiError('CONFLICT', 'target policy item is not need_supplement');
    }

    const applicationStatus = await aggregateApplicationStatusInTransaction(
      tx,
      input.application_id,
    );

    return {
      application_status: applicationStatus,
      policy_item_status: item.status,
      policy_item_review_result: item.review_result,
      materials: materialResults,
    };
  });
}

export async function submitApplicationInTransaction(input: {
  application_id: string;
  policy_item_ids: string[];
  profile_snapshot: {
    enterprise_id: string;
    industry: string;
    scale?: string | null;
    revenue_amount?: number | null;
    employee_count?: number | null;
    tax_amount?: number | null;
    export_amount?: number | null;
    tech_upgrade_status?: string | null;
    source?: string;
    profile_json?: Record<string, unknown>;
  };
}): Promise<{ snapshot_id: string }> {
  return withTransaction(async (tx: DbTransaction) => {
    const snapshot = await tx.queryOne<{ snapshot_id: string }>(
      `
        INSERT INTO enterprise_profile_snapshots (
          enterprise_id,
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        RETURNING snapshot_id
      `,
      [
        input.profile_snapshot.enterprise_id,
        input.profile_snapshot.industry,
        input.profile_snapshot.scale ?? null,
        input.profile_snapshot.revenue_amount ?? null,
        input.profile_snapshot.employee_count ?? null,
        input.profile_snapshot.tax_amount ?? null,
        input.profile_snapshot.export_amount ?? null,
        input.profile_snapshot.tech_upgrade_status ?? null,
        input.profile_snapshot.source ?? 'manual',
        JSON.stringify(input.profile_snapshot.profile_json ?? {}),
      ],
    );

    if (!snapshot) {
      throw new Error('Failed to create enterprise profile snapshot');
    }

    await tx.execute(
      `
        UPDATE applications
        SET
          status = 'submitted',
          submit_time = now(),
          profile_snapshot_id = $2
        WHERE application_id = $1
      `,
      [input.application_id, snapshot.snapshot_id],
    );

    await tx.execute(
      `
        UPDATE application_policy_items
        SET status = 'submitted'
        WHERE item_id = ANY($1::uuid[])
      `,
      [input.policy_item_ids],
    );

    return {
      snapshot_id: snapshot.snapshot_id,
    };
  });
}

export async function withdrawApplicationInTransaction(input: {
  application_id: string;
  comment?: string | null;
}): Promise<{ application_id: string; status: string; withdrawn_at: string }> {
  return withTransaction(async (tx: DbTransaction) => {
    const application = await tx.queryOne<{
      application_id: string;
      status: string;
      withdrawn_at: string;
    }>(
      `
        UPDATE applications
        SET
          status = 'withdrawn'
        WHERE application_id = $1
          AND status::text IN (
            'submitted',
            'pre_reviewing',
            'reviewing',
            'need_supplement',
            'resubmitted',
            'manual_review'
          )
        RETURNING
          application_id::text,
          status::text,
          now()::text AS withdrawn_at
      `,
      [input.application_id],
    );

    if (!application) {
      throw new ApiError('CONFLICT', 'application cannot be withdrawn');
    }

    await tx.execute(
      `
        UPDATE application_policy_items
        SET status = 'withdrawn'
        WHERE application_id = $1
          AND status::text IN (
            'submitted',
            'pre_reviewing',
            'reviewing',
            'need_supplement',
            'resubmitted',
            'manual_review'
          )
      `,
      [input.application_id],
    );

    return application;
  });
}
