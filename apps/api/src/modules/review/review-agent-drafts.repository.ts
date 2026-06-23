import { query, queryOne } from '../../db/query.js';

export type ReviewAgentDraftStatus =
  | 'generated'
  | 'adopted'
  | 'revised'
  | 'ignored';

export type ReviewAgentDraftAction =
  | 'adopt'
  | 'revise'
  | 'ignore';

export type ReviewAgentDraftRow = {
  draft_id: string;
  run_id: string;
  item_id: string;
  application_id: string;
  reviewer_id: string | null;
  status: ReviewAgentDraftStatus;
  suggested_decision: string;
  opinion: string;
  risk_items: unknown[];
  missing_evidence: unknown[];
  reasoning: Record<string, unknown>;
  agent_outputs: Record<string, unknown>;
  handled_by: string | null;
  handled_action: ReviewAgentDraftAction | null;
  handled_comment: string | null;
  revised_opinion: string | null;
  handled_at: string | null;
  created_at: string;
  updated_at: string;
};

function reviewAgentDraftSelectSql(): string {
  return `
    SELECT
      draft_id::text,
      run_id::text,
      item_id::text,
      application_id::text,
      reviewer_id::text,
      status,
      suggested_decision,
      opinion,
      risk_items,
      missing_evidence,
      reasoning,
      agent_outputs,
      handled_by::text,
      handled_action,
      handled_comment,
      revised_opinion,
      handled_at::text,
      created_at::text,
      updated_at::text
    FROM review_agent_drafts
  `;
}

export async function insertReviewAgentDraft(input: {
  run_id: string;
  item_id: string;
  application_id: string;
  reviewer_id: string;
  suggested_decision: string;
  opinion: string;
  risk_items: unknown[];
  missing_evidence: unknown[];
  reasoning: Record<string, unknown>;
  agent_outputs: Record<string, unknown>;
}): Promise<ReviewAgentDraftRow> {
  return queryOne<ReviewAgentDraftRow>(
    `
      INSERT INTO review_agent_drafts (
        run_id,
        item_id,
        application_id,
        reviewer_id,
        suggested_decision,
        opinion,
        risk_items,
        missing_evidence,
        reasoning,
        agent_outputs
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
      RETURNING
        draft_id::text,
        run_id::text,
        item_id::text,
        application_id::text,
        reviewer_id::text,
        status,
        suggested_decision,
        opinion,
        risk_items,
        missing_evidence,
        reasoning,
        agent_outputs,
        handled_by::text,
        handled_action,
        handled_comment,
        revised_opinion,
        handled_at::text,
        created_at::text,
        updated_at::text
    `,
    [
      input.run_id,
      input.item_id,
      input.application_id,
      input.reviewer_id,
      input.suggested_decision,
      input.opinion,
      JSON.stringify(input.risk_items),
      JSON.stringify(input.missing_evidence),
      JSON.stringify(input.reasoning),
      JSON.stringify(input.agent_outputs),
    ],
  ) as Promise<ReviewAgentDraftRow>;
}

export async function listReviewAgentDraftsByItemId(
  itemId: string,
): Promise<ReviewAgentDraftRow[]> {
  return query<ReviewAgentDraftRow>(
    `
      ${reviewAgentDraftSelectSql()}
      WHERE item_id = $1
      ORDER BY created_at DESC, draft_id DESC
    `,
    [itemId],
  );
}

export async function findReviewAgentDraftById(
  draftId: string,
): Promise<ReviewAgentDraftRow | undefined> {
  return queryOne<ReviewAgentDraftRow>(
    `
      ${reviewAgentDraftSelectSql()}
      WHERE draft_id = $1
    `,
    [draftId],
  );
}

export async function updateReviewAgentDraftHandling(input: {
  draft_id: string;
  status: ReviewAgentDraftStatus;
  handled_by: string;
  handled_action: ReviewAgentDraftAction;
  handled_comment?: string | null;
  revised_opinion?: string | null;
}): Promise<ReviewAgentDraftRow | undefined> {
  return queryOne<ReviewAgentDraftRow>(
    `
      UPDATE review_agent_drafts
      SET
        status = $2,
        handled_by = $3,
        handled_action = $4,
        handled_comment = $5,
        revised_opinion = $6,
        handled_at = now()
      WHERE draft_id = $1
        AND status = 'generated'
      RETURNING
        draft_id::text,
        run_id::text,
        item_id::text,
        application_id::text,
        reviewer_id::text,
        status,
        suggested_decision,
        opinion,
        risk_items,
        missing_evidence,
        reasoning,
        agent_outputs,
        handled_by::text,
        handled_action,
        handled_comment,
        revised_opinion,
        handled_at::text,
        created_at::text,
        updated_at::text
    `,
    [
      input.draft_id,
      input.status,
      input.handled_by,
      input.handled_action,
      input.handled_comment ?? null,
      input.revised_opinion ?? null,
    ],
  );
}
