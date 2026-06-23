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

export type ApplicationStatusValue =
  (typeof ApplicationStatus)[keyof typeof ApplicationStatus];
