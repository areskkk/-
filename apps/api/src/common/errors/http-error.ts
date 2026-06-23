import {
  type ErrorCode,
  getHttpStatusByErrorCode,
} from './error-codes.js';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = getHttpStatusByErrorCode(code);
    this.details = details;
  }
}
