import { type ErrorCode } from '../errors/error-codes.js';

export type ApiSuccessResponse<T> = {
  success: true;
  data: T;
  trace_id?: string;
};

export type ApiErrorResponse = {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
  trace_id?: string;
};

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export type SkeletonResponse = {
  implemented: false;
  module: string;
  action: string;
  message: string;
};

export function ok<T>(data: T, traceId?: string): ApiSuccessResponse<T> {
  return {
    success: true,
    data,
    trace_id: traceId,
  };
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  details?: unknown,
  traceId?: string,
): ApiErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    trace_id: traceId,
  };
}

export function skeleton(module: string, action: string): SkeletonResponse {
  return {
    implemented: false,
    module,
    action,
    message: 'Batch 1 only provides API skeleton. Business logic is reserved for later batches.',
  };
}
