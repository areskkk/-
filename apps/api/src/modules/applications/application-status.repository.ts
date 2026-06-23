import { ApiError } from '../../common/errors/http-error.js';
import { type DbTransaction } from '../../db/query.js';

const TERMINAL_APPLICATION_STATUSES = [
  'approved',
  'rejected',
  'withdrawn',
  'timeout_closed',
  'archived',
];

export async function aggregateApplicationStatusInTransaction(
  tx: DbTransaction,
  applicationId: string,
): Promise<string> {
  const application = await tx.queryOne<{ status: string }>(
    `
      SELECT status::text
      FROM applications
      WHERE application_id = $1
      FOR UPDATE
    `,
    [applicationId],
  );
  if (!application) {
    throw new ApiError('NOT_FOUND', 'application not found');
  }
  if (TERMINAL_APPLICATION_STATUSES.includes(application.status)) {
    return application.status;
  }

  const rows = await tx.query<{ status: string }>(
    `
      SELECT status::text
      FROM application_policy_items
      WHERE application_id = $1
      FOR UPDATE
    `,
    [applicationId],
  );
  const statuses = rows.map((row) => row.status);
  let nextStatus = 'reviewing';
  if (statuses.some((status) => status === 'need_supplement')) {
    nextStatus = 'need_supplement';
  } else if (statuses.some((status) => status === 'pre_reviewing')) {
    nextStatus = 'pre_reviewing';
  } else if (statuses.length > 0 && statuses.every((status) => status === 'approved')) {
    nextStatus = 'approved';
  } else if (
    statuses.length > 0 &&
    statuses.every((status) => ['approved', 'rejected'].includes(status)) &&
    statuses.some((status) => status === 'rejected')
  ) {
    nextStatus = 'rejected';
  } else if (statuses.some((status) => status === 'manual_review')) {
    nextStatus = 'manual_review';
  } else if (statuses.some((status) => status === 'resubmitted')) {
    nextStatus = 'resubmitted';
  } else if (statuses.some((status) => status === 'submitted')) {
    nextStatus = 'reviewing';
  }

  const updated = await tx.queryOne<{ status: string }>(
    `
      UPDATE applications
      SET status = $2
      WHERE application_id = $1
        AND status::text <> ALL($3::text[])
      RETURNING status::text
    `,
    [applicationId, nextStatus, TERMINAL_APPLICATION_STATUSES],
  );
  if (!updated) {
    throw new ApiError('CONFLICT', 'application status changed before aggregation');
  }
  return updated.status;
}
