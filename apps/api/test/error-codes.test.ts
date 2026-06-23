import { describe, expect, it } from 'vitest';
import { ERROR_HTTP_STATUS, getHttpStatusByErrorCode } from '../src/common/errors/error-codes.js';

describe('error code mapping', () => {
  it('maps MVP error codes to HTTP status codes', () => {
    expect(getHttpStatusByErrorCode('AUTH_REQUIRED')).toBe(401);
    expect(getHttpStatusByErrorCode('FORBIDDEN')).toBe(403);
    expect(getHttpStatusByErrorCode('NOT_FOUND')).toBe(404);
    expect(getHttpStatusByErrorCode('VALIDATION_ERROR')).toBe(400);
    expect(getHttpStatusByErrorCode('CONFLICT')).toBe(409);
    expect(getHttpStatusByErrorCode('RATE_LIMITED')).toBe(429);
    expect(getHttpStatusByErrorCode('LOW_CONFIDENCE')).toBe(422);
    expect(getHttpStatusByErrorCode('INTERNAL_ERROR')).toBe(500);
    expect(Object.keys(ERROR_HTTP_STATUS)).toHaveLength(8);
  });
});
