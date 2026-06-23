-- 南康助企宝 MVP PostgreSQL DDL
-- 口径：业务表为事实源；LangGraph checkpoint 单独存储恢复点。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE enterprise_status AS ENUM ('pending', 'active', 'disabled');
CREATE TYPE account_role AS ENUM ('owner', 'manager', 'operator', 'viewer');
CREATE TYPE binding_status AS ENUM ('pending', 'agent_approved', 'manual_approved', 'rejected', 'revoked');
CREATE TYPE policy_status AS ENUM ('draft', 'effective', 'revoked', 'archived');
CREATE TYPE application_status AS ENUM ('draft', 'submitted', 'pre_reviewing', 'reviewing', 'need_supplement', 'resubmitted', 'manual_review', 'approved', 'rejected', 'withdrawn', 'timeout_closed', 'archived');
CREATE TYPE eligibility_result AS ENUM ('eligible', 'ineligible', 'need_info', 'manual_review');
CREATE TYPE ocr_status AS ENUM ('pending', 'success', 'low_confidence', 'failed');
CREATE TYPE security_level AS ENUM ('L1', 'L2', 'L3', 'L4');
CREATE TYPE fallback_status AS ENUM ('pending', 'processing', 'resolved', 'closed');

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE departments (
  department_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  parent_id uuid REFERENCES departments(department_id),
  scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  org_id uuid REFERENCES departments(department_id),
  auth_provider text NOT NULL DEFAULT 'local',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE enterprises (
  enterprise_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  credit_code varchar(18) NOT NULL UNIQUE,
  legal_person text,
  status enterprise_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE enterprise_accounts (
  account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL REFERENCES enterprises(enterprise_id),
  user_id uuid NOT NULL REFERENCES users(user_id),
  role account_role NOT NULL,
  auth_status binding_status NOT NULL DEFAULT 'pending',
  agent_review_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enterprise_id, user_id)
);

CREATE TABLE enterprise_profile_snapshots (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL REFERENCES enterprises(enterprise_id),
  industry text NOT NULL,
  scale text,
  revenue_amount numeric(18,2),
  employee_count int,
  tax_amount numeric(18,2),
  export_amount numeric(18,2),
  tech_upgrade_status text,
  source text NOT NULL DEFAULT 'manual',
  profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policies (
  policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  department_id uuid REFERENCES departments(department_id),
  source_type text NOT NULL,
  source_name text,
  source_url text,
  status policy_status NOT NULL DEFAULT 'draft',
  version text NOT NULL DEFAULT 'v1',
  effective_date date,
  expire_date date,
  content text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_conditions (
  condition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES policies(policy_id),
  field_key text NOT NULL,
  operator text NOT NULL,
  target_value jsonb NOT NULL,
  required boolean NOT NULL DEFAULT true,
  evidence_type text NOT NULL,
  fail_action text NOT NULL,
  weight numeric(6,2),
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_material_requirements (
  requirement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES policies(policy_id),
  material_type text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  validity_days int,
  template_url text,
  reuse_allowed_in_application boolean NOT NULL DEFAULT true,
  ocr_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE applications (
  application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL REFERENCES enterprises(enterprise_id),
  applicant_user_id uuid NOT NULL REFERENCES users(user_id),
  profile_snapshot_id uuid NOT NULL REFERENCES enterprise_profile_snapshots(snapshot_id),
  status application_status NOT NULL DEFAULT 'draft',
  submit_time timestamptz,
  deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE application_policy_items (
  item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(application_id),
  policy_id uuid NOT NULL REFERENCES policies(policy_id),
  status application_status NOT NULL DEFAULT 'draft',
  eligibility_result eligibility_result,
  current_department_id uuid REFERENCES departments(department_id),
  review_result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE materials (
  material_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(application_id),
  material_type text NOT NULL,
  file_id text NOT NULL,
  file_hash text NOT NULL,
  issue_date date,
  expire_date date,
  ocr_status ocr_status NOT NULL DEFAULT 'pending',
  security_level security_level NOT NULL DEFAULT 'L3',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ocr_results (
  ocr_result_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id uuid NOT NULL REFERENCES materials(material_id),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  overall_confidence numeric(5,4),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE review_records (
  record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(application_id),
  item_id uuid REFERENCES application_policy_items(item_id),
  reviewer_id uuid REFERENCES users(user_id),
  action text NOT NULL,
  comment text,
  ai_suggestion_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fallback_tasks (
  task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text,
  reason text NOT NULL,
  status fallback_status NOT NULL DEFAULT 'pending',
  owner_team text NOT NULL DEFAULT 'platform_ops',
  due_at timestamptz,
  resolved_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prompt_templates (
  template_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type text NOT NULL,
  version text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  content text NOT NULL,
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_type, version)
);

CREATE TABLE model_finalization_records (
  record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type text NOT NULL,
  selected_model text NOT NULL,
  endpoint text NOT NULL,
  model_version text,
  deployment_location text NOT NULL,
  poc_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  approver text,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  log_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  trace_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE langgraph_checkpoints (
  checkpoint_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL,
  state jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_enterprise_accounts_user ON enterprise_accounts(user_id);
CREATE INDEX idx_profile_enterprise ON enterprise_profile_snapshots(enterprise_id);
CREATE INDEX idx_policies_status ON policies(status);
CREATE INDEX idx_policy_conditions_policy ON policy_conditions(policy_id);
CREATE INDEX idx_applications_enterprise_status ON applications(enterprise_id, status);
CREATE INDEX idx_application_items_app_status ON application_policy_items(application_id, status);
CREATE INDEX idx_materials_application ON materials(application_id);
CREATE INDEX idx_review_records_item ON review_records(item_id);
CREATE INDEX idx_fallback_status_due ON fallback_tasks(status, due_at);
CREATE INDEX idx_audit_trace ON audit_logs(trace_id);
CREATE INDEX idx_checkpoints_run ON langgraph_checkpoints(run_id, created_at DESC);

CREATE TRIGGER trg_departments_updated_at BEFORE UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_enterprises_updated_at BEFORE UPDATE ON enterprises FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_enterprise_accounts_updated_at BEFORE UPDATE ON enterprise_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_policies_updated_at BEFORE UPDATE ON policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_policy_conditions_updated_at BEFORE UPDATE ON policy_conditions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_policy_material_requirements_updated_at BEFORE UPDATE ON policy_material_requirements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_applications_updated_at BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_application_policy_items_updated_at BEFORE UPDATE ON application_policy_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_materials_updated_at BEFORE UPDATE ON materials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_fallback_tasks_updated_at BEFORE UPDATE ON fallback_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_prompt_templates_updated_at BEFORE UPDATE ON prompt_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_model_finalization_records_updated_at BEFORE UPDATE ON model_finalization_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

