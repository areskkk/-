import {
  query,
  queryOne,
  withTransaction,
  type DbTransaction,
} from '../../db/query.js';
import { ApiError } from '../../common/errors/http-error.js';
import { aggregateApplicationStatusInTransaction } from '../applications/application-status.repository.js';

export type ReviewTaskStatus =
  | 'submitted'
  | 'pre_reviewing'
  | 'resubmitted'
  | 'reviewing'
  | 'manual_review';

export type ReviewDecision =
  | 'approve'
  | 'reject'
  | 'request_supplement';

export type ReviewTaskRow = {
  item_id: string;
  application_id: string;
  application_status: string;
  policy_item_status: string;
  review_result: string | null;
  enterprise_id: string;
  enterprise_name: string;
  policy_id: string;
  policy_title: string;
  policy_version: string;
  current_department_id: string | null;
  submit_time: string | null;
  deadline_at: string | null;
  created_at: string;
};

export type ReviewTaskDetailRow = ReviewTaskRow & {
  applicant_user_id: string;
  profile_snapshot_id: string | null;
  policy_content: string | null;
  policy_status: string;
};

export type ReviewProfileSnapshotRow = {
  snapshot_id: string;
  enterprise_id: string;
  industry: string;
  scale: string | null;
  revenue_amount: string | null;
  employee_count: number | null;
  tax_amount: string | null;
  export_amount: string | null;
  tech_upgrade_status: string | null;
  source: string;
  profile_json: Record<string, unknown>;
  created_at: string;
};

export type ReviewMaterialRow = {
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
  created_at: string;
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

export type ReviewRecordRow = {
  record_id: string;
  application_id: string;
  item_id: string | null;
  reviewer_id: string | null;
  action: string;
  comment: string | null;
  ai_suggestion_id: string | null;
  created_at: string;
};

export type ReviewDecisionResultRow = {
  record_id: string;
  application_id: string;
  item_id: string;
  application_status: string;
  policy_item_status: string;
  review_result: string | null;
};

const REVIEW_TASK_STATUSES: ReviewTaskStatus[] = [
  'submitted',
  'pre_reviewing',
  'resubmitted',
  'reviewing',
  'manual_review',
];

export function getReviewTaskStatuses(): ReviewTaskStatus[] {
  return [...REVIEW_TASK_STATUSES];
}

export async function listReviewTasks(input: {
  statuses: string[];
  limit: number;
  offset: number;
}): Promise<ReviewTaskRow[]> {
  return query<ReviewTaskRow>(
    `
      SELECT
        api.item_id::text,
        a.application_id::text,
        a.status::text AS application_status,
        api.status::text AS policy_item_status,
        api.review_result,
        e.enterprise_id::text,
        e.name AS enterprise_name,
        p.policy_id::text,
        p.title AS policy_title,
        p.version AS policy_version,
        api.current_department_id::text,
        a.submit_time::text,
        a.deadline_at::text,
        api.created_at::text
      FROM application_policy_items api
      INNER JOIN applications a ON a.application_id = api.application_id
      INNER JOIN enterprises e ON e.enterprise_id = a.enterprise_id
      INNER JOIN policies p ON p.policy_id = api.policy_id
      WHERE api.status::text = ANY($1::text[])
      ORDER BY a.submit_time DESC NULLS LAST, api.created_at DESC
      LIMIT $2 OFFSET $3
    `,
    [input.statuses, input.limit, input.offset],
  );
}

export async function countReviewTasks(statuses: string[]): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `
      SELECT COUNT(*)::text AS total
      FROM application_policy_items api
      WHERE api.status::text = ANY($1::text[])
    `,
    [statuses],
  );
  return Number(row?.total ?? '0');
}

export async function findReviewTaskByItemId(
  itemId: string,
): Promise<ReviewTaskDetailRow | undefined> {
  return queryOne<ReviewTaskDetailRow>(
    `
      SELECT
        api.item_id::text,
        a.application_id::text,
        a.applicant_user_id::text,
        a.profile_snapshot_id::text,
        a.status::text AS application_status,
        api.status::text AS policy_item_status,
        api.review_result,
        e.enterprise_id::text,
        e.name AS enterprise_name,
        p.policy_id::text,
        p.title AS policy_title,
        p.version AS policy_version,
        p.content AS policy_content,
        p.status::text AS policy_status,
        api.current_department_id::text,
        a.submit_time::text,
        a.deadline_at::text,
        api.created_at::text
      FROM application_policy_items api
      INNER JOIN applications a ON a.application_id = api.application_id
      INNER JOIN enterprises e ON e.enterprise_id = a.enterprise_id
      INNER JOIN policies p ON p.policy_id = api.policy_id
      WHERE api.item_id = $1
    `,
    [itemId],
  );
}

export async function countPolicyItemsByApplicationId(
  applicationId: string,
): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `
      SELECT COUNT(*)::text AS total
      FROM application_policy_items
      WHERE application_id = $1
    `,
    [applicationId],
  );
  return Number(row?.total ?? '0');
}

export async function findProfileSnapshotById(
  snapshotId: string,
): Promise<ReviewProfileSnapshotRow | undefined> {
  return queryOne<ReviewProfileSnapshotRow>(
    `
      SELECT
        snapshot_id::text,
        enterprise_id::text,
        industry,
        scale,
        revenue_amount::text,
        employee_count,
        tax_amount::text,
        export_amount::text,
        tech_upgrade_status,
        source,
        profile_json,
        created_at::text
      FROM enterprise_profile_snapshots
      WHERE snapshot_id = $1
    `,
    [snapshotId],
  );
}

export async function listReviewMaterialsByApplicationId(
  applicationId: string,
): Promise<ReviewMaterialRow[]> {
  return query<ReviewMaterialRow>(
    `
      SELECT
        m.material_id::text,
        m.application_id::text,
        m.policy_item_id::text,
        m.material_type,
        m.file_id::text,
        m.file_hash,
        m.issue_date::text,
        m.expire_date::text,
        m.ocr_status::text,
        m.security_level::text,
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

export async function listReviewRecordsByItemId(
  itemId: string,
): Promise<ReviewRecordRow[]> {
  return query<ReviewRecordRow>(
    `
      SELECT
        record_id::text,
        application_id::text,
        item_id::text,
        reviewer_id::text,
        action,
        comment,
        ai_suggestion_id::text,
        created_at::text
      FROM review_records
      WHERE item_id = $1
      ORDER BY created_at ASC
    `,
    [itemId],
  );
}

export async function applyReviewDecisionInTransaction(input: {
  item_id: string;
  application_id: string;
  reviewer_id: string;
  action: ReviewDecision;
  target_status: string;
  review_result: string;
  comment?: string | null;
}): Promise<ReviewDecisionResultRow> {
  return withTransaction(async (tx: DbTransaction) => {
    const record = await tx.queryOne<{ record_id: string }>(
      `
        INSERT INTO review_records (
          application_id,
          item_id,
          reviewer_id,
          action,
          comment
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING record_id::text
      `,
      [
        input.application_id,
        input.item_id,
        input.reviewer_id,
        input.action,
        input.comment ?? null,
      ],
    );

    if (!record) {
      throw new Error('Failed to create review record');
    }

    const item = await tx.queryOne<{
      item_id: string;
      application_id: string;
      policy_item_status: string;
      review_result: string | null;
    }>(
      `
        UPDATE application_policy_items
        SET
          status = $2,
          review_result = $3
        WHERE item_id = $1
          AND application_id = $4
          AND status::text IN ('submitted', 'pre_reviewing', 'reviewing', 'resubmitted', 'manual_review')
        RETURNING
          item_id::text,
          application_id::text,
          status::text AS policy_item_status,
          review_result
      `,
      [input.item_id, input.target_status, input.review_result, input.application_id],
    );

    if (!item) {
      throw new ApiError('CONFLICT', 'review task status changed before decision');
    }

    const applicationStatus = await aggregateApplicationStatusInTransaction(
      tx,
      input.application_id,
    );

    return {
      record_id: record.record_id,
      application_id: item.application_id,
      item_id: item.item_id,
      application_status: applicationStatus,
      policy_item_status: item.policy_item_status,
      review_result: item.review_result,
    };
  });
}

export async function applyReviewPrecheckInTransaction(input: {
  item_id: string;
  application_id: string;
  reviewer_id: string;
  comment?: string | null;
  precheck: Record<string, unknown>;
}): Promise<ReviewDecisionResultRow> {
  return withTransaction(async (tx: DbTransaction) => {
    const record = await tx.queryOne<{ record_id: string }>(
      `
        INSERT INTO review_records (
          application_id,
          item_id,
          reviewer_id,
          action,
          comment
        )
        VALUES ($1, $2, $3, 'precheck', $4)
        RETURNING record_id::text
      `,
      [
        input.application_id,
        input.item_id,
        input.reviewer_id,
        input.comment ?? JSON.stringify(input.precheck),
      ],
    );
    if (!record) {
      throw new Error('Failed to create precheck review record');
    }

    const item = await tx.queryOne<{
      item_id: string;
      application_id: string;
      policy_item_status: string;
      review_result: string | null;
    }>(
      `
        UPDATE application_policy_items
        SET status = 'pre_reviewing'
        WHERE item_id = $1
          AND application_id = $2
          AND status::text IN ('submitted', 'reviewing', 'resubmitted', 'manual_review')
        RETURNING
          item_id::text,
          application_id::text,
          status::text AS policy_item_status,
          review_result
      `,
      [input.item_id, input.application_id],
    );
    if (!item) {
      throw new ApiError('CONFLICT', 'review task status changed before precheck');
    }

    const applicationStatus = await aggregateApplicationStatusInTransaction(
      tx,
      input.application_id,
    );

    return {
      record_id: record.record_id,
      application_id: item.application_id,
      item_id: item.item_id,
      application_status: applicationStatus,
      policy_item_status: item.policy_item_status,
      review_result: item.review_result,
    };
  });
}

export async function applySupplementRequestInTransaction(input: {
  item_id: string;
  application_id: string;
  reviewer_id: string;
  reason: string;
  deadline_at?: string | null;
  required_materials: unknown[];
  field_requirements: unknown[];
}): Promise<ReviewDecisionResultRow & { deadline_at: string | null }> {
  return withTransaction(async (tx: DbTransaction) => {
    const comment = JSON.stringify({
      reason: input.reason,
      deadline_at: input.deadline_at ?? null,
      required_materials: input.required_materials,
      field_requirements: input.field_requirements,
    });
    const record = await tx.queryOne<{ record_id: string }>(
      `
        INSERT INTO review_records (
          application_id,
          item_id,
          reviewer_id,
          action,
          comment
        )
        VALUES ($1, $2, $3, 'request_supplement', $4)
        RETURNING record_id::text
      `,
      [input.application_id, input.item_id, input.reviewer_id, comment],
    );
    if (!record) {
      throw new Error('Failed to create supplement review record');
    }

    const item = await tx.queryOne<{
      item_id: string;
      application_id: string;
      policy_item_status: string;
      review_result: string | null;
    }>(
      `
        UPDATE application_policy_items
        SET
          status = 'need_supplement',
          review_result = 'need_supplement'
        WHERE item_id = $1
          AND application_id = $2
          AND status::text IN ('submitted', 'pre_reviewing', 'reviewing', 'resubmitted', 'manual_review')
        RETURNING
          item_id::text,
          application_id::text,
          status::text AS policy_item_status,
          review_result
      `,
      [input.item_id, input.application_id],
    );
    if (!item) {
      throw new ApiError('CONFLICT', 'review task status changed before supplement request');
    }

    const applicationStatus = await aggregateApplicationStatusInTransaction(
      tx,
      input.application_id,
    );
    return {
      record_id: record.record_id,
      application_id: item.application_id,
      item_id: item.item_id,
      application_status: applicationStatus,
      policy_item_status: item.policy_item_status,
      review_result: item.review_result,
      deadline_at: input.deadline_at ?? null,
    };
  });
}
