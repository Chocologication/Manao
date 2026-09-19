import { ApiRequestError } from './ApiRequestError';

export const PROJECT_BUSY_READ_MAX_RETRIES = 2;
export const PROJECT_BUSY_READ_RETRY_DELAY_MS = 10;

export function isProjectBusyError(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status === 409 &&
    error.body?.code === 'PROJECT_BUSY'
  );
}

/**
 * Project reads may wait out a short mutex contention: only 409 PROJECT_BUSY
 * is retried, at most PROJECT_BUSY_READ_MAX_RETRIES times. Writes never retry.
 */
export function retryProjectBusyRead(failureCount: number, error: unknown): boolean {
  return failureCount < PROJECT_BUSY_READ_MAX_RETRIES && isProjectBusyError(error);
}
