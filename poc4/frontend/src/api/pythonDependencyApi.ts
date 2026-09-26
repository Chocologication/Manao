import { getHttpClient } from './httpClient';

/**
 * Browser dependency endpoints (design 6.1): one identity per change and a durable
 * COMMITTED answer for lost responses. The operationId is an opaque business identity
 * the browser generates and keeps per user/project; it is never a credential.
 */
export type PythonDependencyAction = 'ADD' | 'REMOVE';

export type PythonDependencyState = 'PENDING' | 'COMMITTED' | 'UNCONFIRMED';

export type PythonDependencyStatus = {
  operationId: string;
  state: PythonDependencyState;
  resultWorkspaceRevision: string | null;
};

export type ChangePythonDependencyRequest = {
  operationId: string;
  action: PythonDependencyAction;
  packageName: string;
  /** Exact version for ADD, always null for REMOVE. */
  version: string | null;
  expectedWorkspaceRevision: string;
};

function projectDependencyUrl(projectId: string, suffix = ''): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/python-dependencies${suffix}`;
}

const DEPENDENCY_STATES: ReadonlySet<string> = new Set(['PENDING', 'COMMITTED', 'UNCONFIRMED']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Honest response parsing: a malformed status never becomes a fabricated result. */
export function parsePythonDependencyStatus(payload: unknown): PythonDependencyStatus {
  const record = asRecord(payload);
  if (
    record === null ||
    typeof record.operationId !== 'string' ||
    record.operationId === '' ||
    typeof record.state !== 'string' ||
    !DEPENDENCY_STATES.has(record.state)
  ) {
    throw new Error('Invalid python dependency status response');
  }
  // The backend omits resultWorkspaceRevision unless the state is COMMITTED.
  const revision = record.resultWorkspaceRevision;
  if (revision !== null && revision !== undefined && typeof revision !== 'string') {
    throw new Error('Invalid python dependency status response');
  }
  return {
    operationId: record.operationId,
    state: record.state as PythonDependencyState,
    resultWorkspaceRevision: typeof revision === 'string' ? revision : null,
  };
}

export function parsePendingPythonDependencies(payload: unknown): PythonDependencyStatus[] {
  const record = asRecord(payload);
  if (record === null || !Array.isArray(record.operations)) {
    throw new Error('Invalid python dependency pending response');
  }
  return record.operations.map((operation) => parsePythonDependencyStatus(operation));
}

/** First POST: prepare and commit one dependency change under its browser-chosen identity. */
export async function changePythonDependencies(
  projectId: string,
  request: ChangePythonDependencyRequest,
): Promise<PythonDependencyStatus> {
  const payload = await getHttpClient().request<unknown>(projectDependencyUrl(projectId), {
    method: 'POST',
    body: request,
  });
  return parsePythonDependencyStatus(payload);
}

/** Read-only status of one operation; only a missing record is UNCONFIRMED. */
export async function getPythonDependencyStatus(
  projectId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<PythonDependencyStatus> {
  const payload = await getHttpClient().request<unknown>(
    projectDependencyUrl(projectId, `/${encodeURIComponent(operationId)}`),
    { signal },
  );
  return parsePythonDependencyStatus(payload);
}

/** Drives one registered operation to its durable result; never a second uv run. */
export async function reconcilePythonDependency(
  projectId: string,
  operationId: string,
): Promise<PythonDependencyStatus> {
  const payload = await getHttpClient().request<unknown>(
    projectDependencyUrl(projectId, `/${encodeURIComponent(operationId)}/reconcile`),
    { method: 'POST' },
  );
  return parsePythonDependencyStatus(payload);
}

/** The project's pending dependency operations for failure pages without a local id. */
export async function listPendingPythonDependencies(
  projectId: string,
  signal?: AbortSignal,
): Promise<PythonDependencyStatus[]> {
  const payload = await getHttpClient().request<unknown>(
    projectDependencyUrl(projectId, '/pending'),
    { signal },
  );
  return parsePendingPythonDependencies(payload);
}

// ---------------------------------------------------------------------------
// Operation identity: generated per change and kept per user/project in
// sessionStorage so a refresh, a lost response or a failure page keeps asking
// about the SAME operation. Public HTTP pages have no secure-context
// crypto.randomUUID guarantee, so the id is built from getRandomValues.
// ---------------------------------------------------------------------------

const OPERATION_STORAGE_PREFIX = 'manao.python-dependency.operation.';

export function pythonDependencyStorageKey(userId: string, projectId: string): string {
  return `${OPERATION_STORAGE_PREFIX}${userId}.${projectId}`;
}

export function generateOperationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}` +
    `-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  );
}

function sessionStorageOrNull(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') {
      return null;
    }
    return sessionStorage;
  } catch {
    return null;
  }
}

/** Called BEFORE the first POST of a change, per user/project. */
export function storePythonDependencyOperationId(
  userId: string,
  projectId: string,
  operationId: string,
): void {
  sessionStorageOrNull()?.setItem(pythonDependencyStorageKey(userId, projectId), operationId);
}

export function readPythonDependencyOperationId(userId: string, projectId: string): string | null {
  return sessionStorageOrNull()?.getItem(pythonDependencyStorageKey(userId, projectId)) ?? null;
}

/** Removed only after the reload completed or an explicitly no-side-effect rejection. */
export function clearPythonDependencyOperationId(userId: string, projectId: string): void {
  sessionStorageOrNull()?.removeItem(pythonDependencyStorageKey(userId, projectId));
}

/** Logout and session expiry must not hand the operation to the next user. */
export function clearPythonDependencyOperationIdsForUser(userId: string): void {
  const storage = sessionStorageOrNull();
  if (storage === null) {
    return;
  }
  const userPrefix = `${OPERATION_STORAGE_PREFIX}${userId}.`;
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(userPrefix)) {
      stale.push(key);
    }
  }
  for (const key of stale) {
    storage.removeItem(key);
  }
}
