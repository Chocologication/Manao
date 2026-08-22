import type { ApiErrorBody, ApiErrorCode } from '../contracts/api';
import { ApiRequestError } from './ApiRequestError';

const API_PREFIX = '/api/v1/';
const API_ERROR_CODES: ReadonlySet<string> = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'PROJECT_LIMIT_REACHED',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
]);

export type HttpClientOptions = {
  getAccessToken(): string | null;
  onUnauthorized(): void;
  fetchImpl?: typeof fetch;
};

export type HttpRequestOptions = {
  method?: string;
  body?: unknown;
  auth?: boolean;
};

let configuredClient: HttpClient | null = null;

export function setHttpClient(client: HttpClient | null): void {
  configuredClient = client;
}

export function getHttpClient(): HttpClient {
  if (configuredClient === null) {
    throw new Error('HttpClient is not configured');
  }
  return configuredClient;
}

export class HttpClient {
  private readonly getAccessToken: () => string | null;
  private readonly onUnauthorized: () => void;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.onUnauthorized = options.onUnauthorized;
    // Look up fetch per request so MSW can patch globalThis.fetch after module init.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async request<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<T> {
    assertRelativeApiV1Url(url);

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const sentToken = options.auth === false ? null : this.getAccessToken();
    if (sentToken) {
      headers.set('Authorization', `Bearer ${sentToken}`);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw new Error('Network request failed');
    }

    if (!response.ok) {
      const body = await readApiErrorBody(response);
      // Login 401 is invalid credentials. Session cleanup only runs when the
      // rejected Bearer token is still the current session credential.
      if (response.status === 401 && sentToken !== null && sentToken === this.getAccessToken()) {
        this.onUnauthorized();
      }
      throw new ApiRequestError(response.status, body);
    }

    return readSuccessBody<T>(response);
  }
}

function assertRelativeApiV1Url(url: string): void {
  if (!url.startsWith(API_PREFIX) || url.includes('://')) {
    throw new Error('Relative /api/v1/ URL required');
  }
}

async function readApiErrorBody(response: Response): Promise<ApiErrorBody | null> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return parseApiErrorBody(JSON.parse(text));
  } catch {
    return null;
  }
}

function parseApiErrorBody(value: unknown): ApiErrorBody | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.code !== 'string' ||
    !API_ERROR_CODES.has(record.code) ||
    typeof record.message !== 'string' ||
    typeof record.traceId !== 'string'
  ) {
    return null;
  }
  return {
    code: record.code as ApiErrorCode,
    message: record.message,
    traceId: record.traceId,
  };
}

async function readSuccessBody<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}
