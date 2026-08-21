export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'PROJECT_LIMIT_REACHED'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR';

export type ApiErrorBody = {
  code: ApiErrorCode;
  message: string;
  traceId: string;
};
