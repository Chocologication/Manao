import type { ApiErrorBody, ApiErrorCode } from '../contracts/api';
import { ApiRequestError } from './ApiRequestError';

const API_PREFIX = '/api/v1/';
const API_ERROR_CODES: ReadonlySet<string> = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'PROJECT_LIMIT_REACHED',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
  'INVALID_PATH',
  'FILE_TOO_LARGE',
  'BINARY_FILE',
  'PROJECT_LOCKED',
  'WORKSPACE_REVISION_CONFLICT',
  'ENTRY_ALREADY_EXISTS',
  'ENTRY_NOT_FOUND',
  'DIRECTORY_NOT_EMPTY',
  'RUN_ALREADY_ACTIVE',
  'RUN_STATE_CONFLICT',
  'RUN_NOT_FOUND',
  'LOG_TICKET_NOT_AVAILABLE',
  'TERMINAL_NOT_AVAILABLE',
  'TERMINAL_SESSION_ALREADY_ACTIVE',
  'TERMINAL_TICKET_NOT_AVAILABLE',
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
  signal?: AbortSignal;
};

export type BlobRequestOptions = {
  method?: string;
  auth?: boolean;
  fallbackName?: string;
  signal?: AbortSignal;
};

export type BlobResponse = {
  blob: Blob;
  filename: string;
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
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await this.send(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      auth: options.auth,
      signal: options.signal,
    });
    return readSuccessBody<T>(response);
  }

  async requestBlob(url: string, options: BlobRequestOptions = {}): Promise<BlobResponse> {
    const headers = new Headers();
    headers.set('Accept', 'application/octet-stream');
    const response = await this.send(url, {
      method: options.method ?? 'GET',
      headers,
      auth: options.auth,
      signal: options.signal,
    });
    const blob = await response.blob();
    return {
      blob,
      filename: resolveDownloadFilename(
        response.headers.get('Content-Disposition'),
        options.fallbackName,
      ),
    };
  }

  private async send(
    url: string,
    options: { method: string; headers: Headers; body?: string; auth?: boolean; signal?: AbortSignal },
  ): Promise<Response> {
    assertRelativeApiV1Url(url);

    const sentToken = options.auth === false ? null : this.getAccessToken();
    if (sentToken) {
      options.headers.set('Authorization', `Bearer ${sentToken}`);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: options.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
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

    return response;
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('name' in error && error.name === 'AbortError') {
    return true;
  }
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.code === DOMException.ABORT_ERR;
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

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const extended = /filename\*\s*=\s*(?:UTF-8)''([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Invalid percent-encoding is ignored; fall back to filename= or caller name.
    }
  }
  const quoted = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header);
  if (quoted) {
    return quoted[1].replace(/\\(.)/g, '$1');
  }
  const unquoted = /filename\s*=\s*([^;]+)/i.exec(header);
  if (!unquoted) {
    return null;
  }
  return unquoted[1].trim();
}

function sanitizeDownloadFilename(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }
  const segments = raw.split(/[/\\]/);
  const last = segments[segments.length - 1] ?? '';
  let cleaned = '';
  for (const char of last) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      continue;
    }
    cleaned += char;
  }
  cleaned = cleaned.trim();
  return cleaned === '' ? null : cleaned;
}

function resolveDownloadFilename(
  contentDisposition: string | null,
  fallbackName: string | undefined,
): string {
  return (
    sanitizeDownloadFilename(parseContentDispositionFilename(contentDisposition)) ??
    sanitizeDownloadFilename(fallbackName) ??
    'download'
  );
}
