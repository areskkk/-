export const ErrorCode = {
  AuthRequired: 'AUTH_REQUIRED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  ValidationError: 'VALIDATION_ERROR',
  Conflict: 'CONFLICT',
  RateLimited: 'RATE_LIMITED',
  LowConfidence: 'LOW_CONFIDENCE',
  InternalError: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
