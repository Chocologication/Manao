export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'PROJECT_LIMIT_REACHED'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR'
  | 'INVALID_PATH'
  | 'FILE_TOO_LARGE'
  | 'BINARY_FILE';

export type ApiErrorBody = {
  code: ApiErrorCode;
  message: string;
  traceId: string;
};
