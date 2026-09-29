import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorCode } from '../contracts/api';
import { ApiRequestError } from './ApiRequestError';
import {
  PROJECT_BUSY_READ_MAX_RETRIES,
  PROJECT_BUSY_READ_RETRY_BASE_DELAY_MS,
  PROJECT_BUSY_READ_RETRY_JITTER_MS,
  readWithProjectBusyRetry,
} from './projectBusyRetry';

// Faithful to what httpClient throws: an ApiRequestError carrying the HTTP
// status and the parsed error body (status + body.code decide the policy).
function apiError(status: number, code: ApiErrorCode): ApiRequestError {
  return new ApiRequestError(status, { code, message: 'Request failed', traceId: 'trace-busy-retry' });
}

async function settleRejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (reason) {
    return reason;
  }
  throw new Error('expected the read to fail');
}

describe('readWithProjectBusyRetry', () => {
  it('retries one PROJECT_BUSY failure and resolves the eventual value', async () => {
    let calls = 0;
    const result = await readWithProjectBusyRetry(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(apiError(409, 'PROJECT_BUSY'));
      }
      return Promise.resolve([{ operationId: 'op-1' }]);
    });

    expect(result).toEqual([{ operationId: 'op-1' }]);
    expect(calls).toBe(2);
  });

  it('rethrows the last error after PROJECT_BUSY_READ_MAX_RETRIES extra attempts', async () => {
    const failure = apiError(409, 'PROJECT_BUSY');
    let calls = 0;

    const reason = await settleRejected(
      readWithProjectBusyRetry(() => {
        calls += 1;
        return Promise.reject(failure);
      }),
    );

    expect(calls).toBe(1 + PROJECT_BUSY_READ_MAX_RETRIES);
    expect(reason).toBe(failure);
  }, 15_000);

  it('does not retry a 409 whose body code is not PROJECT_BUSY', async () => {
    const failure = apiError(409, 'PROJECT_LOCKED');
    let calls = 0;

    const reason = await settleRejected(
      readWithProjectBusyRetry(() => {
        calls += 1;
        return Promise.reject(failure);
      }),
    );

    expect(calls).toBe(1);
    expect(reason).toBe(failure);
  });

  it('does not retry auth, permission, server or network failures', async () => {
    const failures: unknown[] = [
      apiError(401, 'UNAUTHENTICATED'),
      apiError(403, 'FORBIDDEN'),
      apiError(500, 'INTERNAL_ERROR'),
      new Error('Network request failed'),
    ];

    for (const failure of failures) {
      let calls = 0;
      const reason = await settleRejected(
        readWithProjectBusyRetry(() => {
          calls += 1;
          return Promise.reject(failure);
        }),
      );
      expect(calls).toBe(1);
      expect(reason).toBe(failure);
    }
  });

  it('spends the shared 250/500/1000ms backoff plus bounded jitter between retries', async () => {
    vi.useFakeTimers();
    try {
      const failure = apiError(409, 'PROJECT_BUSY');
      const attemptTimes: number[] = [];
      let settled = false;
      void readWithProjectBusyRetry(() => {
        // Date.now() is faked by default, so this is virtual clock time.
        attemptTimes.push(Date.now());
        return Promise.reject(failure);
      }).catch(() => {
        settled = true;
      });

      for (let i = 0; i < 400 && !settled; i += 1) {
        await vi.advanceTimersByTimeAsync(25);
      }

      expect(settled).toBe(true);
      expect(attemptTimes).toHaveLength(1 + PROJECT_BUSY_READ_MAX_RETRIES);
      const gaps = attemptTimes.slice(1).map((time, index) => time - attemptTimes[index]);
      const minimumTotalDelayMs =
        PROJECT_BUSY_READ_RETRY_BASE_DELAY_MS * (2 ** PROJECT_BUSY_READ_MAX_RETRIES - 1);
      const jitterCapMs = PROJECT_BUSY_READ_MAX_RETRIES * PROJECT_BUSY_READ_RETRY_JITTER_MS;
      const totalDelayMs = gaps.reduce((sum, gap) => sum + gap, 0);
      expect(totalDelayMs).toBeGreaterThanOrEqual(minimumTotalDelayMs);
      expect(totalDelayMs).toBeLessThan(minimumTotalDelayMs + jitterCapMs);
    } finally {
      vi.useRealTimers();
    }
  });
});
