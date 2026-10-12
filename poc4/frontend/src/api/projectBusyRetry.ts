import { ApiRequestError } from './ApiRequestError';

export const PROJECT_BUSY_READ_MAX_RETRIES = 3;
export const PROJECT_BUSY_READ_RETRY_BASE_DELAY_MS = 250;
export const PROJECT_BUSY_READ_RETRY_JITTER_MS = 100;

export function isProjectBusyError(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status === 409 &&
    error.body?.code === 'PROJECT_BUSY'
  );
}

/**
 * Project reads may wait out a short mutex contention: only 409 PROJECT_BUSY
 * is retried, at most PROJECT_BUSY_READ_MAX_RETRIES extra times (4 requests
 * total). Writes never retry, and other 409 business codes are not treated as
 * PROJECT_BUSY.
 */
export function retryProjectBusyRead(failureCount: number, error: unknown): boolean {
  return failureCount < PROJECT_BUSY_READ_MAX_RETRIES && isProjectBusyError(error);
}

/**
 * Roughly 250/500/1000ms plus a little jitter, so concurrent busy reads do not
 * re-contend the project lock in lockstep. React Query passes the failure count
 * before incrementing it, so the first retry waits ~250ms.
 */
export function projectBusyReadRetryDelay(failureCount: number): number {
  const base = PROJECT_BUSY_READ_RETRY_BASE_DELAY_MS * 2 ** failureCount;
  return base + Math.floor(Math.random() * PROJECT_BUSY_READ_RETRY_JITTER_MS);
}

/**
 * Same bounded PROJECT_BUSY read policy as `retryProjectBusyRead`, for one-shot
 * reads outside React Query: at most PROJECT_BUSY_READ_MAX_RETRIES extra attempts
 * with the shared backoff above. Any other error, or an exhausted budget, rethrows
 * the original error — a failed read is never reported as a value.
 */
export async function readWithProjectBusyRetry<T>(read: () => Promise<T>): Promise<T> {
  let failedAttempt = 0;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (failedAttempt >= PROJECT_BUSY_READ_MAX_RETRIES || !isProjectBusyError(error)) {
        throw error;
      }
      const delay = projectBusyReadRetryDelay(failedAttempt);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });
      failedAttempt += 1;
    }
  }
}
