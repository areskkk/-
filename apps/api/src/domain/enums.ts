export const EnterpriseStatus = {
  Pending: 'pending',
  Active: 'active',
  Disabled: 'disabled',
} as const;

export const AccountRole = {
  Owner: 'owner',
  Manager: 'manager',
  Operator: 'operator',
  Viewer: 'viewer',
} as const;

export const BindingStatus = {
  Pending: 'pending',
  AgentApproved: 'agent_approved',
  ManualApproved: 'manual_approved',
  Rejected: 'rejected',
  Revoked: 'revoked',
} as const;

export const PolicyStatus = {
  Draft: 'draft',
  Effective: 'effective',
  Revoked: 'revoked',
  Archived: 'archived',
} as const;

export const ApplicationStatus = {
  Draft: 'draft',
  Submitted: 'submitted',
  PreReviewing: 'pre_reviewing',
  Reviewing: 'reviewing',
  NeedSupplement: 'need_supplement',
  Resubmitted: 'resubmitted',
  ManualReview: 'manual_review',
  Approved: 'approved',
  Rejected: 'rejected',
  Withdrawn: 'withdrawn',
  TimeoutClosed: 'timeout_closed',
  Archived: 'archived',
} as const;

export const EligibilityResult = {
  Eligible: 'eligible',
  Ineligible: 'ineligible',
  NeedInfo: 'need_info',
  ManualReview: 'manual_review',
} as const;

export const OcrStatus = {
  Pending: 'pending',
  Success: 'success',
  LowConfidence: 'low_confidence',
  Failed: 'failed',
} as const;

export const SecurityLevel = {
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  L4: 'L4',
} as const;

export const FallbackStatus = {
  Pending: 'pending',
  Processing: 'processing',
  Resolved: 'resolved',
  Closed: 'closed',
} as const;

export type ValueOf<T> = T[keyof T];
export type EnterpriseStatusValue = ValueOf<typeof EnterpriseStatus>;
export type AccountRoleValue = ValueOf<typeof AccountRole>;
export type BindingStatusValue = ValueOf<typeof BindingStatus>;
export type PolicyStatusValue = ValueOf<typeof PolicyStatus>;
export type ApplicationStatusValue = ValueOf<typeof ApplicationStatus>;
export type EligibilityResultValue = ValueOf<typeof EligibilityResult>;
export type OcrStatusValue = ValueOf<typeof OcrStatus>;
export type SecurityLevelValue = ValueOf<typeof SecurityLevel>;
export type FallbackStatusValue = ValueOf<typeof FallbackStatus>;
