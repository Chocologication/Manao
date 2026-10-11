import { DEFAULT_PROJECT_LIMIT } from '../contracts/project';
import { http, HttpResponse } from 'msw';
import type { ApiErrorBody } from '../contracts/api';
import type { AuthUser, LoginRequest } from '../contracts/auth';
import type {
  ProjectPublicPort,
  ProjectRuntimeConfig,
  RuntimeTemplateId,
} from '../contracts/project';
import { isPythonRuntimeTemplate } from '../contracts/project';
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
  findOwnedProjectCreation,
  removeOwnedProject,
  expireCurrentToken,
  getDependencyScenario,
  getWriteScenario,
  isDependencyScenario,
  isLargeFileBodiesEnabled,
  isWriteScenario,
  isValidMockPackageName,
  isValidMockPackageVersion,
  listOwnedProjectSummaries,
  listPendingMockDependencyOperations,
  loginWithCredentials,
  mockBatchRequestFingerprint,
  mockDependencyRequestFingerprint,
  normalizeMockPackageName,
  parseMockBatchLimits,
  parseMockBatchPackages,
  readOwnedProjectSummary,
  recordFileRequest,
  registerMockDependencyOperation,
  commitMockDependencyOperation,
  findMockDependencyOperation,
  resolveUserByAccessToken,
  setDependencyScenario,
  setLargeFileBodiesEnabled,
  setWriteScenario,
  WRITE_SCENARIO_DELAY_MS,
  type MockDependencyOperation,
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

const PYTHON_DEPENDENCY_UNSUPPORTED: ApiErrorBody = {
  code: 'PYTHON_DEPENDENCY_UNSUPPORTED',
  message: 'Dependency changes are not supported for this project or package',
  traceId: 'mock-trace-dependency-unsupported',
};

const PYTHON_DEPENDENCY_RESOLUTION_FAILED: ApiErrorBody = {
  code: 'PYTHON_DEPENDENCY_RESOLUTION_FAILED',
  message: 'Dependency resolution failed',
  traceId: 'mock-trace-dependency-resolution',
};

const WORKSPACE_RECONCILIATION_REQUIRED: ApiErrorBody = {
  code: 'WORKSPACE_RECONCILIATION_REQUIRED',
  message: 'Workspace needs reconciliation; the operation result is not confirmed',
  traceId: 'mock-trace-workspace-reconciliation',
};

const DEPENDENCY_REQUEST_MISMATCH: ApiErrorBody = {
  code: 'DEPENDENCY_REQUEST_MISMATCH',
  message: 'This operation id was already used for a different request',
  traceId: 'mock-trace-dependency-mismatch',
};

const RUN_ALREADY_ACTIVE: ApiErrorBody = {
  code: 'RUN_ALREADY_ACTIVE',
  message: 'A run is already active',
  traceId: 'mock-trace-run-already-active',
};

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

function readParam(value: string | readonly string[] | undefined): string | null {
  const id = Array.isArray(value) ? value[0] : value;
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

const RUNTIME_TEMPLATES: ReadonlySet<RuntimeTemplateId> = new Set([
  'java-console',
  'java-spring-boot-web',
  'python-console',
  'python-fastapi-web',
]);

/** Console templates never expose public ports (python-console also stays dependency-free). */
const CONSOLE_TEMPLATES: ReadonlySet<RuntimeTemplateId> = new Set(['java-console', 'python-console']);

/**
 * Reads the runtime configuration of a create body. A legacy name-only body yields null;
 * any template field turns the request into a structured console/web configuration.
 */
function parseRuntimeFromBody(
  record: Record<string, unknown>,
): { ok: true; runtime: ProjectRuntimeConfig | null } | { ok: false } {
  const configured =
    'templateId' in record || 'mysql' in record || 'redis' in record || 'publicPorts' in record;
  if (!configured) {
    return { ok: true, runtime: null };
  }
  const templateId = record.templateId;
  if (typeof templateId !== 'string' || !RUNTIME_TEMPLATES.has(templateId as RuntimeTemplateId)) {
    return { ok: false };
  }
  const publicPortEntries = record.publicPorts;
  if (publicPortEntries !== undefined && !Array.isArray(publicPortEntries)) {
    return { ok: false };
  }
  const publicPorts: ProjectPublicPort[] = [];
  for (const entry of publicPortEntries ?? []) {
    const port = asRecord(entry);
    if (
      port === null ||
      typeof port.name !== 'string' ||
      port.name === '' ||
      typeof port.targetPort !== 'number' ||
      !Number.isSafeInteger(port.targetPort) ||
      port.targetPort < 1 ||
      port.targetPort > 65535 ||
      typeof port.publicPort !== 'number' ||
      !Number.isSafeInteger(port.publicPort) ||
      port.publicPort < 30000 ||
      port.publicPort > 31000
    ) {
      return { ok: false };
    }
    publicPorts.push({
      name: port.name,
      targetPort: port.targetPort,
      publicPort: port.publicPort,
    });
  }
  if (CONSOLE_TEMPLATES.has(templateId as RuntimeTemplateId) && publicPorts.length > 0) {
    return { ok: false };
  }
  if (templateId === 'python-console' && (record.mysql === true || record.redis === true)) {
    return { ok: false };
  }
  return {
    ok: true,
    runtime: {
      templateId: templateId as RuntimeTemplateId,
      mysql: record.mysql === true,
      redis: record.redis === true,
      publicPorts,
    },
  };
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

type DependencyChangeBody = {
  operationId: string;
  action: 'ADD' | 'REMOVE';
  packageName: string;
  version: string | null;
  expectedWorkspaceRevision: string;
};

function isDependencyChangeBody(value: unknown): value is DependencyChangeBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.operationId === 'string' &&
    record.operationId !== '' &&
    (record.action === 'ADD' || record.action === 'REMOVE') &&
    typeof record.packageName === 'string' &&
    record.packageName !== '' &&
    (record.version === null || typeof record.version === 'string') &&
    typeof record.expectedWorkspaceRevision === 'string' &&
    record.expectedWorkspaceRevision !== ''
  );
}

type DependencyBatchBody = {
  operationId: string;
  requirementsText: string;
  expectedWorkspaceRevision: string;
};

function isDependencyBatchBody(value: unknown): value is DependencyBatchBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.operationId === 'string' &&
    record.operationId !== '' &&
    typeof record.requirementsText === 'string' &&
    typeof record.expectedWorkspaceRevision === 'string' &&
    record.expectedWorkspaceRevision !== ''
  );
}

function dependencyStatusJson(operation: MockDependencyOperation) {
  return {
    operationId: operation.operationId,
    state: operation.state,
    resultWorkspaceRevision: operation.resultWorkspaceRevision,
  };
}

function unconfirmedStatusJson(operationId: string) {
  return { operationId, state: 'UNCONFIRMED', resultWorkspaceRevision: null };
}

function isPythonRuntimeProject(userId: string, projectId: string): boolean {
  const project = readOwnedProjectSummary(userId, projectId);
  return isPythonRuntimeTemplate(project?.runtime?.templateId);
}

export const dependencyHandlers = [
  // Mock-only: choose dependency-scenario behavior. Forbidden in production modules.
  http.post('/api/v1/session/dependency-scenario', async ({ request }) => {
    if (resolveUserByAccessToken(readBearerToken(request)) === null) {
      return jsonError(401, REQUEST_UNAUTHENTICATED);
    }
    const body = asRecord(await readJsonBody(request));
    if (body === null || !isDependencyScenario(body.scenario)) {
      return jsonError(400, FILE_VALIDATION_ERROR);
    }
    setDependencyScenario(body.scenario);
    return new HttpResponse(null, { status: 204 });
  }),

  // Registered BEFORE the :operationId route so 'pending' is never read as an id.
  http.get('/api/v1/projects/:projectId/python-dependencies/pending', ({ request, params }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    const projectId = readProjectId(params);
    if (projectId === null || readOwnedProjectSummary(auth.user.id, projectId) === null) {
      return jsonError(403, FORBIDDEN);
    }
    return HttpResponse.json({
      operations: listPendingMockDependencyOperations(projectId).map(dependencyStatusJson),
    });
  }),

  http.get('/api/v1/projects/:projectId/python-dependencies/:operationId', ({ request, params }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    const projectId = readProjectId(params);
    const operationId = readParam(params.operationId);
    if (
      projectId === null ||
      operationId === null ||
      readOwnedProjectSummary(auth.user.id, projectId) === null
    ) {
      return jsonError(403, FORBIDDEN);
    }
    const operation = findMockDependencyOperation(projectId, operationId);
    if (operation === null) {
      // Only a missing record is UNCONFIRMED; it never authorizes a resend.
      return HttpResponse.json(unconfirmedStatusJson(operationId));
    }
    return HttpResponse.json(dependencyStatusJson(operation));
  }),

  http.post(
    '/api/v1/projects/:projectId/python-dependencies/:operationId/reconcile',
    ({ request, params }) => {
      const auth = authorize(request);
      if ('response' in auth) {
        return auth.response;
      }
      const projectId = readProjectId(params);
      const operationId = readParam(params.operationId);
      if (
        projectId === null ||
        operationId === null ||
        readOwnedProjectSummary(auth.user.id, projectId) === null
      ) {
        return jsonError(403, FORBIDDEN);
      }
      const operation = findMockDependencyOperation(projectId, operationId);
      if (operation === null) {
        return HttpResponse.json(unconfirmedStatusJson(operationId));
      }
      if (operation.state === 'PENDING') {
        commitMockDependencyOperation(operation);
      }
      return HttpResponse.json(dependencyStatusJson(operation));
    },
  ),

  http.post('/api/v1/projects/:projectId/python-dependencies', async ({ request, params }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    const projectId = readProjectId(params);
    if (projectId === null || readOwnedProjectSummary(auth.user.id, projectId) === null) {
      return jsonError(403, FORBIDDEN);
    }
    const body = asRecord(await readJsonBody(request));
    if (body === null || !isDependencyChangeBody(body)) {
      return jsonError(422, FILE_VALIDATION_ERROR);
    }
    const scenario = getDependencyScenario();
    if (!isPythonRuntimeProject(auth.user.id, projectId)) {
      return jsonError(422, PYTHON_DEPENDENCY_UNSUPPORTED);
    }
    const packageName = normalizeMockPackageName(body.packageName);
    if (!isValidMockPackageName(packageName)) {
      return jsonError(422, FILE_VALIDATION_ERROR);
    }
    let version: string | null = body.version;
    if (body.action === 'REMOVE') {
      if (version !== null && version !== '') {
        return jsonError(422, FILE_VALIDATION_ERROR);
      }
      version = null;
    } else if (version !== null && version !== '' && !isValidMockPackageVersion(version)) {
      return jsonError(422, FILE_VALIDATION_ERROR);
    } else if (version === '') {
      version = null;
    }
    const revision = getWorkspaceRevision(projectId);
    if (body.expectedWorkspaceRevision !== revision) {
      return jsonError(409, WORKSPACE_REVISION_CONFLICT);
    }
    if (hasActiveRun(projectId)) {
      return jsonError(409, RUN_ALREADY_ACTIVE);
    }
    const fingerprint = mockDependencyRequestFingerprint(
      projectId,
      body.action,
      packageName,
      version,
      revision,
    );
    const registered = findMockDependencyOperation(projectId, body.operationId);
    if (registered !== null) {
      if (registered.fingerprint !== fingerprint) {
        return jsonError(409, DEPENDENCY_REQUEST_MISMATCH);
      }
      if (registered.state === 'PENDING') {
        commitMockDependencyOperation(registered);
      }
      return HttpResponse.json(dependencyStatusJson(registered));
    }
    if (scenario === 'resolution-failed') {
      // Fixed prepare rejection: no durable trace, a safe correction for the browser.
      return jsonError(503, PYTHON_DEPENDENCY_RESOLUTION_FAILED);
    }
    const operation = registerMockDependencyOperation({
      projectId,
      operationId: body.operationId,
      fingerprint,
      action: body.action,
      packageName,
      version,
    });
    if (scenario === 'reconciliation-required') {
      // The row is registered PENDING and stays PENDING: the answer refuses to
      // confirm the result, like the backend's fail-closed commit. A later
      // reconcile of the same id commits it.
      return jsonError(409, WORKSPACE_RECONCILIATION_REQUIRED);
    }
    commitMockDependencyOperation(operation);
    if (scenario === 'lost-response') {
      // The commit happened but the browser never learns about it here.
      return HttpResponse.error();
    }
    return HttpResponse.json(dependencyStatusJson(operation));
  }),

  // Batch import: one whole requirements.txt through the SAME operation protocol —
  // one registration, one commit, one revision move. Never a per-line loop.
  http.post('/api/v1/projects/:projectId/python-dependencies/batch', async ({ request, params }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    const projectId = readProjectId(params);
    if (projectId === null || readOwnedProjectSummary(auth.user.id, projectId) === null) {
      return jsonError(403, FORBIDDEN);
    }
    const body = asRecord(await readJsonBody(request));
    if (body === null || !isDependencyBatchBody(body)) {
      return jsonError(422, FILE_VALIDATION_ERROR);
    }
    // Mirror the backend's parseBatchRequest: the byte budget and the line count are
    // decided before the registered row, the template and the revision.
    const requirementLines = parseMockBatchLimits(body.requirementsText);
    if (requirementLines === null) {
      return jsonError(422, FILE_VALIDATION_ERROR);
    }
    const normalizedText = requirementLines.join('\n');
    // The request digest covers the REQUEST's revision, like the backend's digest: a
    // lost-response retry presents the original request and must find its row.
    const fingerprint = mockBatchRequestFingerprint(
      projectId,
      normalizedText,
      body.expectedWorkspaceRevision,
    );
    // Mirror the backend's changeLocked: the registered identity ALWAYS answers first —
    // the same id with the same digest returns the original durable COMMITTED result or
    // redrives PENDING, never misjudged by the revision that has since moved.
    const registered = findMockDependencyOperation(projectId, body.operationId);
    if (registered !== null) {
      if (registered.fingerprint !== fingerprint) {
        return jsonError(409, DEPENDENCY_REQUEST_MISMATCH);
      }
      if (registered.state === 'PENDING') {
        commitMockDependencyOperation(registered);
      }
      return HttpResponse.json(dependencyStatusJson(registered));
    }
    const scenario = getDependencyScenario();
    if (!isPythonRuntimeProject(auth.user.id, projectId)) {
      return jsonError(422, PYTHON_DEPENDENCY_UNSUPPORTED);
    }
    const revision = getWorkspaceRevision(projectId);
    if (body.expectedWorkspaceRevision !== revision) {
      return jsonError(409, WORKSPACE_REVISION_CONFLICT);
    }
    if (hasActiveRun(projectId)) {
      return jsonError(409, RUN_ALREADY_ACTIVE);
    }
    if (parseMockBatchPackages(requirementLines) === null) {
      // Mirrors the agent helper's filter_requirements at the prepare position: a line
      // outside the plain public-PyPI requirement form is a fixed UNSUPPORTED rejection
      // with no durable trace — never a silent skip and never a COMMITTED row.
      return jsonError(422, PYTHON_DEPENDENCY_UNSUPPORTED);
    }
    if (scenario === 'resolution-failed') {
      // Fixed prepare rejection: no durable trace, a safe correction for the browser.
      return jsonError(503, PYTHON_DEPENDENCY_RESOLUTION_FAILED);
    }
    const operation = registerMockDependencyOperation({
      projectId,
      operationId: body.operationId,
      fingerprint,
      action: 'ADD',
      packageName: '',
      version: null,
      requirementsText: normalizedText,
    });
    if (scenario === 'reconciliation-required') {
      // The row is registered PENDING and stays PENDING: the answer refuses to
      // confirm the result, like the backend's fail-closed commit.
      return jsonError(409, WORKSPACE_RECONCILIATION_REQUIRED);
    }
    commitMockDependencyOperation(operation);
    if (scenario === 'lost-response') {
      // The commit happened but the browser never learns about it here.
      return HttpResponse.error();
    }
    return HttpResponse.json(dependencyStatusJson(operation));
  }),
];

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
      limit: DEFAULT_PROJECT_LIMIT,
    });
  }),

  http.post('/api/v1/projects', async ({ request }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    const body = asRecord(await readJsonBody(request));
    const name =
      body !== null && typeof body.name === 'string' && body.name !== '' ? body.name : null;
    if (body === null || name === null) {
      return jsonError(400, VALIDATION_ERROR);
    }
    const runtime = parseRuntimeFromBody(body);
    if (!runtime.ok) {
      return jsonError(400, VALIDATION_ERROR);
    }
    const creationKey =
      typeof body.creationKey === 'string' && body.creationKey !== '' ? body.creationKey : null;
    const result = createOwnedProject(auth.user.id, name, {
      creationKey,
      runtime: runtime.runtime,
    });
    if (result.status === 'limit') {
      return jsonError(409, PROJECT_LIMIT_REACHED);
    }
    return HttpResponse.json(result.project, { status: 201 });
  }),

  // Same creation key always returns the same project identity for the owner.
  http.get('/api/v1/projects/creation/:creationKey', ({ request, params }) => {
    const auth = authorize(request);
    if ('response' in auth) {
      return auth.response;
    }
    const creationKey = readParam(params.creationKey);
    if (creationKey === null) {
      return jsonError(404, ENTRY_NOT_FOUND);
    }
    const project = findOwnedProjectCreation(auth.user.id, creationKey);
    if (project === null) {
      return jsonError(404, ENTRY_NOT_FOUND);
    }
    return HttpResponse.json(project);
  }),

  http.delete('/api/v1/projects/:projectId', ({ request, params }) => {
    const auth = authorize(request);
    if ('response' in auth) return auth.response;
    const id = String(params.projectId);
    const project = readOwnedProjectSummary(auth.user.id, id);
    if (!project) return jsonError(403, FORBIDDEN);
    const code = project.state === 'CREATING' ? 'PROJECT_CREATING'
      : hasActiveRun(id) ? 'RUN_ALREADY_ACTIVE' : null;
    if (code) return jsonError(409, { code, message: 'Project is busy', traceId: 'mock-delete' });
    removeOwnedProject(auth.user.id, id);
    return new HttpResponse(null, { status: 204 });
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

  ...dependencyHandlers,
  ...runHandlers,
  ...terminalHandlers,
];
