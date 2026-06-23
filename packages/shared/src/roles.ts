export const EnterpriseAccountRole = {
  Owner: 'owner',
  Manager: 'manager',
  Operator: 'operator',
  Viewer: 'viewer',
} as const;

export const GovernmentRole = {
  Reviewer: 'reviewer',
  WindowStaff: 'window_staff',
  DepartmentLead: 'department_lead',
} as const;

export const AdminRole = {
  SystemAdmin: 'system_admin',
  PolicyAdmin: 'policy_admin',
  KbOperator: 'kb_operator',
  QaReviewer: 'qa_reviewer',
} as const;

export type ValueOf<T> = T[keyof T];
export type EnterpriseAccountRoleValue = ValueOf<typeof EnterpriseAccountRole>;
export type GovernmentRoleValue = ValueOf<typeof GovernmentRole>;
export type AdminRoleValue = ValueOf<typeof AdminRole>;
