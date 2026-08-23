export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'PROJECT_LIMIT_REACHED'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR'
  | 'INVALID_PATH'
  | 'FILE_TOO_LARGE'
  | 'BINARY_FILE'
  | 'PROJECT_LOCKED'
  | 'WORKSPACE_REVISION_CONFLICT'
  | 'ENTRY_ALREADY_EXISTS'
  | 'ENTRY_NOT_FOUND'
  | 'DIRECTORY_NOT_EMPTY';

export type ApiErrorBody = {
  code: ApiErrorCode;
  message: string;
  traceId: string;
};
