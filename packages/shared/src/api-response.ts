export type ApiSuccessResponse<T> = {
  success: true;
  data: T;
  trace_id?: string;
};

export type ApiErrorResponse<TCode extends string = string> = {
  success: false;
  error: {
    code: TCode;
    message: string;
    details?: unknown;
  };
  trace_id?: string;
};

export type ApiResponse<T, TCode extends string = string> =
  | ApiSuccessResponse<T>
  | ApiErrorResponse<TCode>;
