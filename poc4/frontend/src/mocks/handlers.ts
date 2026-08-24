import { http, HttpResponse } from 'msw';
import type { ApiErrorBody } from '../contracts/api';
import type { AuthUser, LoginRequest } from '../contracts/auth';
import {
  parseProjectDirectoryPath,
  parseProjectRelativePath,
} from '../features/files/pathPolicy';
import {
  contentDispositionHeader,
  createMockEntry,
  deleteMockEntry,
  directoryExists,
  getMockFile,
  getWorkspaceRevision,
  listDirectoryEntries,
  renameMockEntry,
  resolveFileBytes,
  resolveFileText,
  saveMockFile,
  toFileMetadataJson,
  type MockMutationError,
} from './fileFixtures';
import { runHandlers } from './runHandlers';
import { hasActiveRun, isRunScenario, setRunScenario } from './runState';
import { terminalHandlers } from './terminalHandlers';
import {
  canReadReadyProjectFiles,
  createOwnedProject,
  expireCurrentToken,
  getWriteScenario,
  isLargeFileBodiesEnabled,
  isWriteScenario,
  listOwnedProjectSummaries,
  loginWithCredentials,
  readOwnedProjectSummary,
  recordFileRequest,
  resolveUserByAccessToken,
  setLargeFileBodiesEnabled,
  setWriteScenario,
  WRITE_SCENARIO_DELAY_MS,
} from './state';

const LOGIN_UNAUTHENTICATED: ApiErrorBody = {
  code: 'UNAUTHENTICATED',
  message: 'Invalid username or password',
  traceId: 'mock-trace-login',
};

const REQUEST_UNAUTHENTICATED: ApiErrorBody = {
  code: 'UNAUTHENTICATED',
  message: 'Authentication required',
  traceId: 'mock-trace-unauthenticated',
};

const FORBIDDEN: ApiErrorBody = {
  code: 'FORBIDDEN',
  message: 'Access denied',
  traceId: 'mock-trace-forbidden',
};

const PROJECT_LIMIT_REACHED: ApiErrorBody = {
  code: 'PROJECT_LIMIT_REACHED',
  message: 'Project limit reached',
  traceId: 'mock-trace-project-limit',
};

const VALIDATION_ERROR: ApiErrorBody = {
  code: 'VALIDATION_ERROR',
  message: 'Invalid project name',
  traceId: 'mock-trace-validation',
};

const INVALID_PATH: ApiErrorBody = {
  code: 'INVALID_PATH',
  message: 'Invalid path',
  traceId: 'mock-trace-invalid-path',
};

const FILE_TOO_LARGE: ApiErrorBody = {
  code: 'FILE_TOO_LARGE',
  message: 'File too large',
  traceId: 'mock-trace-file-too-large',
};

const BINARY_FILE: ApiErrorBody = {
  code: 'BINARY_FILE',
  message: 'Binary file',
  traceId: 'mock-trace-binary-file',
};

const FILE_VALIDATION_ERROR: ApiErrorBody = {
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  traceId: 'mock-trace-file-validation',
};

const PROJECT_LOCKED: ApiErrorBody = {
  code: 'PROJECT_LOCKED',
  message: 'Project is locked',
  traceId: 'mock-trace-project-locked',
};

const WORKSPACE_REVISION_CONFLICT: ApiErrorBody = {
  code: 'WORKSPACE_REVISION_CONFLICT',
  message: 'Workspace revision conflict',
  traceId: 'mock-trace-revision-conflict',
};

const ENTRY_ALREADY_EXISTS: ApiErrorBody = {
  code: 'ENTRY_ALREADY_EXISTS',
  message: 'Entry already exists',
  traceId: 'mock-trace-entry-exists',
};

const ENTRY_NOT_FOUND: ApiErrorBody = {
  code: 'ENTRY_NOT_FOUND',
  message: 'Entry not found',
  traceId: 'mock-trace-entry-not-found',
};

const DIRECTORY_NOT_EMPTY: ApiErrorBody = {
  code: 'DIRECTORY_NOT_EMPTY',
  message: 'Directory is not empty',
  traceId: 'mock-trace-directory-not-empty',
};

const INTERNAL_ERROR: ApiErrorBody = {
  code: 'INTERNAL_ERROR',
  message: 'Internal error',
  traceId: 'mock-trace-internal',
};

function jsonError(status: number, body: ApiErrorBody) {
  return HttpResponse.json(body, { status });
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (header === null || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function authorize(
  request: Request,
): { user: AuthUser } | { response: ReturnType<typeof jsonError> } {
  const user = resolveUserByAccessToken(readBearerToken(request));
  if (user === null) {
    return { response: jsonError(401, REQUEST_UNAUTHENTICATED) };
  }
  return { user };
}

function isLoginRequest(value: unknown): value is LoginRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.username === 'string' && typeof record.password === 'string';
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function readProjectId(params: { projectId?: string | readonly string[] }): string | null {
  const projectId = params.projectId;
  const id = Array.isArray(projectId) ? projectId[0] : projectId;
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  return id;
}

function readQueryPath(request: Request): string | null {
  return new URL(request.url).searchParams.get('path');
}

function authorizeReadyFiles(
  request: Request,
  params: { projectId?: string | readonly string[] },
): { projectId: string } | { response: ReturnType<typeof jsonError> } {
  const auth = authorize(request);
  if ('response' in auth) {
    return auth;
  }
  const projectId = readProjectId(params);
  if (projectId === null || !canReadReadyProjectFiles(auth.user.id, projectId)) {
    return { response: jsonError(403, FORBIDDEN) };
  }
  return { projectId };
}

function parseDirectoryQuery(rawPath: string | null): string | null {
  if (rawPath === null) {
    return null;
  }
  try {
    return parseProjectDirectoryPath(rawPath);
  } catch {
    return null;
  }
}

function parseFileQuery(rawPath: string | null): string | null {
  if (rawPath === null) {
    return null;
  }
  try {
    return parseProjectRelativePath(rawPath);
  } catch {
    return null;
  }
}

function lookupFile(projectId: string, rawPath: string | null) {
  const path = parseFileQuery(rawPath);
  if (path === null || directoryExists(projectId, path)) {
    return null;
  }
  return getMockFile(projectId, path);
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function mutationErrorResponse(error: MockMutationError) {
  switch (error) {
    case 'invalid-path':
      return jsonError(400, INVALID_PATH);
    case 'validation':
      return jsonError(400, FILE_VALIDATION_ERROR);
    case 'not-found':
      return jsonError(409, ENTRY_NOT_FOUND);
    case 'already-exists':
      return jsonError(409, ENTRY_ALREADY_EXISTS);
    case 'not-empty':
      return jsonError(409, DIRECTORY_NOT_EMPTY);
    case 'too-large':
      return jsonError(413, FILE_TOO_LARGE);
    case 'binary':
      return jsonError(415, BINARY_FILE);
    case 'unsupported-encoding':
      return jsonError(400, FILE_VALIDATION_ERROR);
  }
}

async function applyWriteScenario(): Promise<ReturnType<typeof jsonError> | null> {
  const scenario = getWriteScenario();
  if (scenario === 'delayed') {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, WRITE_SCENARIO_DELAY_MS);
    });
    return null;
  }
  if (scenario === 'locked') {
    return jsonError(409, PROJECT_LOCKED);
  }
  if (scenario === 'conflict') {
    return jsonError(409, WORKSPACE_REVISION_CONFLICT);
  }
  if (scenario === 'failure') {
    return jsonError(500, INTERNAL_ERROR);
  }
  return null;
}

async function gateWrite(
  request: Request,
  params: { projectId?: string | readonly string[] },
  expectedWorkspaceRevision: unknown,
): Promise<{ projectId: string } | { response: ReturnType<typeof jsonError> }> {
  const access = authorizeReadyFiles(request, params);
  if ('response' in access) {
    return access;
  }
  if (typeof expectedWorkspaceRevision !== 'string' || expectedWorkspaceRevision === '') {
    return { response: jsonError(400, FILE_VALIDATION_ERROR) };
  }
  if (expectedWorkspaceRevision !== getWorkspaceRevision(access.projectId)) {
    return { response: jsonError(409, WORKSPACE_REVISION_CONFLICT) };
  }
  if (hasActiveRun(access.projectId)) {
    return { response: jsonError(409, PROJECT_LOCKED) };
  }
  const scenarioResponse = await applyWriteScenario();
  if (scenarioResponse !== null) {
    return { response: scenarioResponse };
  }
  return { projectId: access.projectId };
}

export const handlers = [
  http.post('/api/v1/auth/login', async ({ request }) => {
    const body = await readJsonBody(request);
    if (!isLoginRequest(body)) {
      return jsonError(401, LOGIN_UNAUTHENTICATED);
    }
    const session = loginWithCredentials(body.username, body.password);
    if (session === null) {
      return jsonError(401, LOGIN_UNAUTHENTICATED);
    }
    return HttpResponse.json(session);
  }),

  // Mock-only: invalidate the presented token so the next real GET 401s.
  http.post('/api/v1/session/expire', ({ request }) => {
    if (!expireCurrentToken(readBearerToken(request))) {
      return jsonError(401, REQUEST_UNAUTHENTICATED);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // Mock-only: serve actual 20 MiB bodies. Core Stage 2 e2e must not call this.
  http.post('/api/v1/session/large-files', ({ request }) => {
    if (resolveUserByAccessToken(readBearerToken(request)) === null) {
      return jsonError(401, REQUEST_UNAUTHENTICATED);
    }
    setLargeFileBodiesEnabled(true);
    return new HttpResponse(null, { status: 204 });
  }),

  // Mock-only: choose write-scenario behavior for Stage 3 E2E. Forbidden in production modules.
  http.post('/api/v1/session/write-scenario', async ({ request }) => {
    if (resolveUserByAccessToken(readBearerToken(request)) === null) {
      return jsonError(401, REQUEST_UNAUTHENTICATED);
    }
    const body = asRecord(await readJsonBody(request));
    if (body === null || !isWriteScenario(body.scenario)) {
      return jsonError(400, FILE_VALIDATION_ERROR);
    }
    setWriteScenario(body.scenario);
    return new HttpResponse(null, { status: 204 });
  }),

  // Mock-only: choose run-scenario behavior for Stage 4 E2E. Forbidden in production modules.
  http.post('/api/v1/session/run-scenario', async ({ request }) => {
    if (resolveUserByAccessToken(readBearerToken(request)) === null) {
      return jsonError(401, REQUEST_UNAUTHENTICATED);
    }
    const body = asRecord(await readJsonBody(request));
    if (body === null || !isRunScenario(body.scenario)) {
      return jsonError(400, FILE_VALIDATION_ERROR);
    }
    setRunScenario(body.scenario);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/api/v1/projects', ({ request }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    return HttpResponse.json({
      items: listOwnedProjectSummaries(auth.user.id),
      limit: 3,
    });
  }),

  http.post('/api/v1/projects', async ({ request }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    const body = await readJsonBody(request);
    const name =
      body !== null &&
      typeof body === 'object' &&
      'name' in body &&
      typeof body.name === 'string'
        ? body.name
        : null;
    if (name === null) {
      return jsonError(400, VALIDATION_ERROR);
    }
    const result = createOwnedProject(auth.user.id, name);
    if (result.status === 'limit') {
      return jsonError(409, PROJECT_LIMIT_REACHED);
    }
    return HttpResponse.json(result.project, { status: 202 });
  }),

  http.get('/api/v1/projects/:projectId', ({ request, params }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    const projectId = params.projectId;
    const id = Array.isArray(projectId) ? projectId[0] : projectId;
    if (typeof id !== 'string' || id.length === 0) {
      return jsonError(403, FORBIDDEN);
    }
    const project = readOwnedProjectSummary(auth.user.id, id);
    if (project === null) {
      // Same generic 403 for unknown and non-owned ids; do not leak existence.
      return jsonError(403, FORBIDDEN);
    }
    return HttpResponse.json(project);
  }),

  http.get('/api/v1/projects/:projectId/files/tree', ({ request, params }) => {
    const access = authorizeReadyFiles(request, params);
    if ('response' in access) {
      return access.response;
    }
    const rawPath = readQueryPath(request);
    recordFileRequest('tree', access.projectId, rawPath ?? '');
    const directory = parseDirectoryQuery(rawPath);
    if (directory === null) {
      return jsonError(400, INVALID_PATH);
    }
    const entries = listDirectoryEntries(access.projectId, directory);
    if (entries === null) {
      return jsonError(400, INVALID_PATH);
    }
    return HttpResponse.json({
      directory,
      entries,
      workspaceRevision: getWorkspaceRevision(access.projectId),
    });
  }),

  http.get('/api/v1/projects/:projectId/files/meta', ({ request, params }) => {
    const access = authorizeReadyFiles(request, params);
    if ('response' in access) {
      return access.response;
    }
    const rawPath = readQueryPath(request);
    recordFileRequest('meta', access.projectId, rawPath ?? '');
    const file = lookupFile(access.projectId, rawPath);
    if (file === null) {
      return jsonError(400, INVALID_PATH);
    }
    return HttpResponse.json(toFileMetadataJson(file));
  }),

  http.get('/api/v1/projects/:projectId/files/content', ({ request, params }) => {
    const access = authorizeReadyFiles(request, params);
    if ('response' in access) {
      return access.response;
    }
    const rawPath = readQueryPath(request);
    recordFileRequest('content', access.projectId, rawPath ?? '');
    const file = lookupFile(access.projectId, rawPath);
    if (file === null) {
      return jsonError(400, INVALID_PATH);
    }
    if (file.renderMode === 'BLOCKED') {
      if (file.blockReason === 'BINARY_FILE') {
        return jsonError(415, BINARY_FILE);
      }
      if (file.blockReason === 'FILE_TOO_LARGE') {
        return jsonError(413, FILE_TOO_LARGE);
      }
      return jsonError(400, FILE_VALIDATION_ERROR);
    }
    const payload = JSON.stringify({
      path: file.path,
      content: resolveFileText(file, isLargeFileBodiesEnabled()),
      workspaceRevision: getWorkspaceRevision(access.projectId),
    });
    return new HttpResponse(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
      },
    });
  }),

  http.get('/api/v1/projects/:projectId/files/download', ({ request, params }) => {
    const access = authorizeReadyFiles(request, params);
    if ('response' in access) {
      return access.response;
    }
    const rawPath = readQueryPath(request);
    recordFileRequest('download', access.projectId, rawPath ?? '');
    const file = lookupFile(access.projectId, rawPath);
    if (file === null) {
      return jsonError(400, INVALID_PATH);
    }
    const bytes = resolveFileBytes(file, isLargeFileBodiesEnabled());
    return new HttpResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDispositionHeader(file.name),
      },
    });
  }),

  http.put('/api/v1/projects/:projectId/files/content', async ({ request, params }) => {
    const access = authorizeReadyFiles(request, params);
    if ('response' in access) {
      return access.response;
    }
    const rawPath = readQueryPath(request);
    const path = parseFileQuery(rawPath);
    if (path === null || directoryExists(access.projectId, path)) {
      return jsonError(400, INVALID_PATH);
    }
    const body = asRecord(await readJsonBody(request));
    const gated = await gateWrite(request, params, body?.expectedWorkspaceRevision);
    if ('response' in gated) {
      return gated.response;
    }
    if (body === null || typeof body.content !== 'string') {
      return jsonError(400, FILE_VALIDATION_ERROR);
    }
    const result = saveMockFile(gated.projectId, path, body.content);
    if (!result.ok) {
      return mutationErrorResponse(result.error);
    }
    return HttpResponse.json({
      file: toFileMetadataJson(result.file),
      workspaceRevision: result.workspaceRevision,
    });
  }),

  http.post('/api/v1/projects/:projectId/entries/rename', async ({ request, params }) => {
    const access = authorizeReadyFiles(request, params);
    if ('response' in access) {
      return access.response;
    }
    const body = asRecord(await readJsonBody(request));
    const path = parseFileQuery(typeof body?.path === 'string' ? body.path : null);
    const nextPath = parseFileQuery(typeof body?.nextPath === 'string' ? body.nextPath : null);
    if (path === null || nextPath === null) {
      return jsonError(400, INVALID_PATH);
    }
    if (parentOf(path) !== parentOf(nextPath)) {
      return jsonError(400, FILE_VALIDATION_ERROR);
    }
    const gated = await gateWrite(request, params, body?.expectedWorkspaceRevision);
    if ('response' in gated) {
      return gated.response;
    }
    const result = renameMockEntry(gated.projectId, path, nextPath);
    if (!result.ok) {
      return mutationErrorResponse(result.error);
    }
    return HttpResponse.json({
      path: result.path,
      nextPath: result.nextPath,
      entry: result.entry,
      file: result.file === null ? null : toFileMetadataJson(result.file),
      workspaceRevision: result.workspaceRevision,
    });
  }),

  http.post('/api/v1/projects/:projectId/entries', async ({ request, params }) => {
    const access = authorizeReadyFiles(request, params);
    if ('response' in access) {
      return access.response;
    }
    const body = asRecord(await readJsonBody(request));
    const path = parseFileQuery(typeof body?.path === 'string' ? body.path : null);
    if (path === null || !directoryExists(access.projectId, parentOf(path))) {
      return jsonError(400, INVALID_PATH);
    }
    const kind = body?.kind;
    if (kind !== 'file' && kind !== 'directory') {
      return jsonError(400, FILE_VALIDATION_ERROR);
    }
    const gated = await gateWrite(request, params, body?.expectedWorkspaceRevision);
    if ('response' in gated) {
      return gated.response;
    }
    const result = createMockEntry(gated.projectId, kind, path);
    if (!result.ok) {
      return mutationErrorResponse(result.error);
    }
    return HttpResponse.json({
      entry: result.entry,
      file: result.file === null ? null : toFileMetadataJson(result.file),
      workspaceRevision: result.workspaceRevision,
    });
  }),

  http.delete('/api/v1/projects/:projectId/entries', async ({ request, params }) => {
    const access = authorizeReadyFiles(request, params);
    if ('response' in access) {
      return access.response;
    }
    const rawPath = readQueryPath(request);
    const path = parseFileQuery(rawPath);
    if (path === null) {
      return jsonError(400, INVALID_PATH);
    }
    const body = asRecord(await readJsonBody(request));
    const gated = await gateWrite(request, params, body?.expectedWorkspaceRevision);
    if ('response' in gated) {
      return gated.response;
    }
    const result = deleteMockEntry(gated.projectId, path);
    if (!result.ok) {
      return mutationErrorResponse(result.error);
    }
    return HttpResponse.json({
      path: result.path,
      workspaceRevision: result.workspaceRevision,
    });
  }),

  ...runHandlers,
  ...terminalHandlers,
];
