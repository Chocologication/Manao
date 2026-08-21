import type { ApiErrorBody } from '../contracts/api';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;
  readonly traceId: string | null;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.message ?? `Request failed with status ${status}`);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
    this.traceId = body?.traceId ?? null;
  }
}
