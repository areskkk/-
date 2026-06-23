import { query } from '../../db/query.js';

export type QaPolicyRow = {
  policy_id: string;
  title: string;
  version: string;
  source_name: string | null;
  source_url: string | null;
  content: string | null;
};

export async function listWhitelistedEffectivePolicies(input: {
  policy_id?: string;
}): Promise<QaPolicyRow[]> {
  const params: unknown[] = [];
  let policyFilter = '';
  if (input.policy_id) {
    params.push(input.policy_id);
    policyFilter = `AND p.policy_id = $${params.length}`;
  }

  return query<QaPolicyRow>(
    `
      SELECT
        p.policy_id::text,
        p.title,
        p.version,
        p.source_name,
        p.source_url,
        p.content
      FROM policies p
      INNER JOIN policy_ai_whitelist w ON w.policy_id = p.policy_id
      WHERE p.status = 'effective'
        AND w.enabled = true
        ${policyFilter}
      ORDER BY p.created_at DESC
      LIMIT 20
    `,
    params,
  );
}
