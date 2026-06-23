export const ReviewStatus = {
  Pending: 'pending',
  Processing: 'processing',
  Approved: 'approved',
  Rejected: 'rejected',
  NeedSupplement: 'need_supplement',
  ManualReview: 'manual_review',
} as const;

export type ReviewStatusValue =
  (typeof ReviewStatus)[keyof typeof ReviewStatus];
