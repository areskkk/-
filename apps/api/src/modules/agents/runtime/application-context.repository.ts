import { queryOne } from '../../../db/query.js';

export type ApplicationAgentContextRow = {
  application_id: string;
  item_id: string;
  enterprise_id: string;
  applicant_user_id: string;
  policy_id: string;
  policy_title: string;
  policy_version: string;
  application_status: string;
  policy_item_status: string;
};

export async function findApplicationAgentContext(
  applicationId: string,
  itemId?: string,
): Promise<ApplicationAgentContextRow | undefined> {
  return queryOne<ApplicationAgentContextRow>(
    `
      SELECT
        a.application_id::text,
        api.item_id::text,
        a.enterprise_id::text,
        a.applicant_user_id::text,
        api.policy_id::text,
        p.title AS policy_title,
        p.version AS policy_version,
        a.status::text AS application_status,
        api.status::text AS policy_item_status
      FROM applications a
      INNER JOIN application_policy_items api ON api.application_id = a.application_id
      INNER JOIN policies p ON p.policy_id = api.policy_id
      WHERE a.application_id = $1
        AND ($2::uuid IS NULL OR api.item_id = $2::uuid)
      ORDER BY api.created_at ASC, api.item_id ASC
      LIMIT 1
    `,
    [applicationId, itemId ?? null],
  );
}

export async function countApplicationPolicyItems(
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
