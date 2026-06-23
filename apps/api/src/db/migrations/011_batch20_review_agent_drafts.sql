CREATE TABLE review_agent_drafts (
  draft_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES application_policy_items(item_id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
  reviewer_id uuid REFERENCES users(user_id),
  status text NOT NULL DEFAULT 'generated',
  suggested_decision text NOT NULL,
  opinion text NOT NULL,
  risk_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  reasoning jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_outputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  handled_by uuid REFERENCES users(user_id),
  handled_action text,
  handled_comment text,
  revised_opinion text,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_review_agent_draft_status
    CHECK (status IN ('generated', 'adopted', 'revised', 'ignored')),
  CONSTRAINT chk_review_agent_draft_suggested_decision
    CHECK (suggested_decision IN ('approve', 'reject', 'request_supplement', 'manual_review')),
  CONSTRAINT chk_review_agent_draft_handled_action
    CHECK (
      handled_action IS NULL
      OR handled_action IN ('adopt', 'revise', 'ignore')
    )
);

CREATE INDEX idx_review_agent_drafts_item_created
ON review_agent_drafts(item_id, created_at DESC);

CREATE INDEX idx_review_agent_drafts_run
ON review_agent_drafts(run_id);

CREATE TRIGGER trg_review_agent_drafts_updated_at
BEFORE UPDATE ON review_agent_drafts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
