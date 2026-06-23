export const ERROR_HTTP_STATUS = {
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  LOW_CONFIDENCE: 422,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export function getHttpStatusByErrorCode(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}
