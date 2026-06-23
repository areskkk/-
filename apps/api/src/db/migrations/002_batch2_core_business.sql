ALTER TABLE users
ADD COLUMN password_hash text,
ADD COLUMN user_type text NOT NULL DEFAULT 'enterprise';

CREATE TABLE roles (
  role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id)
);

CREATE TABLE enterprise_profiles (
  profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL UNIQUE REFERENCES enterprises(enterprise_id) ON DELETE CASCADE,
  enterprise_name text NOT NULL,
  credit_code varchar(18) NOT NULL,
  industry text,
  scale text,
  revenue_amount numeric(18,2),
  employee_count int,
  tax_amount numeric(18,2),
  export_amount numeric(18,2),
  tech_upgrade_status text,
  source text NOT NULL DEFAULT 'manual',
  profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE INDEX idx_user_roles_role ON user_roles(role_id);
CREATE INDEX idx_enterprise_profiles_enterprise ON enterprise_profiles(enterprise_id);
CREATE INDEX idx_users_phone ON users(phone);

CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_enterprise_profiles_updated_at BEFORE UPDATE ON enterprise_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO roles (code, name, scope) VALUES
  ('owner', 'Enterprise Owner', 'enterprise'),
  ('manager', 'Enterprise Manager', 'enterprise'),
  ('operator', 'Enterprise Operator', 'enterprise'),
  ('viewer', 'Enterprise Viewer', 'enterprise'),
  ('system_admin', 'System Admin', 'admin'),
  ('policy_admin', 'Policy Admin', 'admin'),
  ('kb_operator', 'Knowledge Base Operator', 'admin'),
  ('qa_reviewer', 'QA Reviewer', 'admin')
ON CONFLICT (code) DO NOTHING;
