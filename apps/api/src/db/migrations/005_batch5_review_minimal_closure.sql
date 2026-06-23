INSERT INTO roles (code, name, scope) VALUES
  ('window_staff', 'Window Staff', 'government'),
  ('reviewer', 'Reviewer', 'government'),
  ('department_lead', 'Department Lead', 'government')
ON CONFLICT (code) DO NOTHING;
