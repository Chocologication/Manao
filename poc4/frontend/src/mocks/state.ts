import { DEFAULT_PROJECT_LIMIT } from '../contracts/project';
import type { AuthUser, LoginResponse } from '../contracts/auth';
import type {
  ProjectEndpointState,
  ProjectRuntimeConfig,
  ProjectState,
  ProjectSummary,
} from '../contracts/project';
import { clearLargeFileBodyCache, ensureWorkspace, removeWorkspace, resetWorkspaces } from './fileFixtures';
import {
  createMockEntry,
  getMockFile,
  getWorkspaceRevision,
  saveMockFile,
} from './fileFixtures';
import { resetLogTickets } from './runSocket';
import { bootRunState, removeProjectRuns, resetRunState } from './runState';

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const PROJECT_LIMIT = DEFAULT_PROJECT_LIMIT;

export const ALICE_SEED_PROJECT_ID = 'prj-alice-notebook';
export const BOB_SEED_PROJECT_ID = 'prj-bob-lab';
export const MOCK_FAILURE_REASON = 'Mock workspace provisioning failed';

type MockUser = {
  id: string;
  username: string;
  password: string;
};

type MockProject = {
  id: string;
  ownerId: string;
  name: string;
  state: ProjectState;
  createdAt: string;
  failureReason: string | null;
  observeCount: number;
  runtime: ProjectRuntimeConfig | null;
  creationKey: string | null;
  endpointState: ProjectEndpointState;
};

type IssuedToken = {
  userId: string;
  expiresAt: string;
};

const USERS: readonly MockUser[] = [
  { id: 'usr-alice', username: 'alice', password: 'demo-pass' },
  { id: 'usr-bob', username: 'bob', password: 'demo-pass' },
];

let projects: MockProject[] = [];
let tokens = new Map<string, IssuedToken>();
let creationKeys = new Map<string, string>();
let nextProjectSeq = 0;
let nextTokenSeq = 0;
let fileRequestCounts = new Map<string, number>();
let largeFileBodiesEnabled = false;
let writeScenario: WriteScenario = 'normal';
let resetTerminalMockState = (): void => undefined;

// Python dependency mock state (design 6.1); declared before the module-init reset below.
let dependencyOperations: MockDependencyOperation[] = [];
let dependencyScenario: MockDependencyScenario = 'normal';

export const WRITE_SCENARIO_DELAY_MS = 250;

export type WriteScenario = 'normal' | 'delayed' | 'locked' | 'conflict' | 'failure';

const WRITE_SCENARIOS: ReadonlySet<WriteScenario> = new Set([
  'normal',
  'delayed',
  'locked',
  'conflict',
  'failure',
]);

export function isWriteScenario(value: unknown): value is WriteScenario {
  return typeof value === 'string' && WRITE_SCENARIOS.has(value as WriteScenario);
}

export function setWriteScenario(scenario: WriteScenario): void {
  writeScenario = scenario;
}

export function getWriteScenario(): WriteScenario {
  return writeScenario;
}

function toSummary(project: MockProject): ProjectSummary {
  // Mock fixtures mirror the runtime-aware view shape: selected dependencies stay
  // PROVISIONING because the mock never provisions a real cluster.
  return {
    id: project.id,
    name: project.name,
    state: project.state,
    createdAt: project.createdAt,
    failureReason: project.failureReason,
    ...(project.runtime !== null ? { runtime: project.runtime } : {}),
    ...(project.endpointState !== 'NONE' ? { endpointState: project.endpointState } : {}),
    ...(project.runtime !== null
      ? {
          dependencies: {
            mysql: project.runtime.mysql ? 'PROVISIONING' : 'ABSENT',
            redis: project.runtime.redis ? 'PROVISIONING' : 'ABSENT',
          },
        }
      : {}),
    ...(project.runtime !== null && project.endpointState === 'ASSIGNED'
      ? {
          endpoints: project.runtime.publicPorts.map((port) => ({
            name: port.name,
            targetPort: port.targetPort,
            publicPort: port.publicPort,
            url: null,
          })),
        }
      : {}),
  };
}

function seedProjects(): MockProject[] {
  return [
    {
      id: ALICE_SEED_PROJECT_ID,
      ownerId: 'usr-alice',
      name: 'Alice Notebook',
      state: 'READY',
      createdAt: '2026-08-21T00:00:00.000Z',
      failureReason: null,
      observeCount: 0,
      runtime: null,
      creationKey: null,
      endpointState: 'NONE',
    },
    {
      id: BOB_SEED_PROJECT_ID,
      ownerId: 'usr-bob',
      name: 'Bob Lab',
      state: 'READY',
      createdAt: '2026-08-21T00:00:01.000Z',
      failureReason: null,
      observeCount: 0,
      runtime: null,
      creationKey: null,
      endpointState: 'NONE',
    },
  ];
}

function fileRequestKey(method: string, projectId: string, path: string): string {
  return `${method}\0${projectId}\0${path}`;
}

export function recordFileRequest(method: string, projectId: string, path: string): void {
  const key = fileRequestKey(method, projectId, path);
  fileRequestCounts.set(key, (fileRequestCounts.get(key) ?? 0) + 1);
}

export function getFileRequestCount(method: string, projectId: string, path: string): number {
  return fileRequestCounts.get(fileRequestKey(method, projectId, path)) ?? 0;
}

export function setLargeFileBodiesEnabled(enabled: boolean): void {
  largeFileBodiesEnabled = enabled;
  if (!enabled) {
    clearLargeFileBodyCache();
  }
}

export function isLargeFileBodiesEnabled(): boolean {
  return largeFileBodiesEnabled;
}

export function canReadReadyProjectFiles(userId: string, projectId: string): boolean {
  const project = projects.find((candidate) => candidate.id === projectId);
  return project !== undefined && project.ownerId === userId && project.state === 'READY';
}

export function registerTerminalStateReset(resetter: () => void): void {
  resetTerminalMockState = resetter;
}

function resetSessionState(): void {
  tokens = new Map();
  creationKeys = new Map();
  nextProjectSeq = 0;
  nextTokenSeq = 0;
  projects = seedProjects();
  fileRequestCounts = new Map();
  largeFileBodiesEnabled = false;
  writeScenario = 'normal';
  dependencyOperations = [];
  dependencyScenario = 'normal';
  resetWorkspaces();
  clearLargeFileBodyCache();
}

export function resetMockState(): void {
  resetSessionState();
  resetRunState();
  resetLogTickets();
  resetTerminalMockState();
}

resetSessionState();
bootRunState();

export function loginWithCredentials(
  username: string,
  password: string,
): LoginResponse | null {
  const user = USERS.find(
    (candidate) => candidate.username === username && candidate.password === password,
  );
  if (user === undefined) {
    return null;
  }
  nextTokenSeq += 1;
  const accessToken = `tok-${nextTokenSeq}`;
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
  tokens.set(accessToken, { userId: user.id, expiresAt });
  return {
    accessToken,
    expiresAt,
    user: { id: user.id, username: user.username },
  };
}

export function expireCurrentToken(token: string | null): boolean {
  if (token === null || token.length === 0) {
    return false;
  }
  return tokens.delete(token);
}

export function resolveUserByAccessToken(token: string | null): AuthUser | null {
  if (token === null || token.length === 0) {
    return null;
  }
  const issued = tokens.get(token);
  if (issued === undefined) {
    return null;
  }
  if (Date.now() >= Date.parse(issued.expiresAt)) {
    return null;
  }
  const user = USERS.find((candidate) => candidate.id === issued.userId);
  if (user === undefined) {
    return null;
  }
  return { id: user.id, username: user.username };
}

// CREATING becomes READY/FAILED after two GETs that include the project (detail or list).
function observeProject(project: MockProject): ProjectSummary {
  if (project.state === 'CREATING') {
    project.observeCount += 1;
    if (project.observeCount >= 2) {
      if (project.name.startsWith('fail-')) {
        project.state = 'FAILED';
        project.failureReason = MOCK_FAILURE_REASON;
      } else {
        project.state = 'READY';
        project.failureReason = null;
      }
    }
  }
  return toSummary(project);
}

export function listOwnedProjectSummaries(userId: string): ProjectSummary[] {
  return projects
    .filter((project) => project.ownerId === userId)
    .map((project) => observeProject(project));
}

export function readOwnedProjectSummary(
  userId: string,
  projectId: string,
): ProjectSummary | null {
  const project = projects.find((candidate) => candidate.id === projectId);
  if (project === undefined || project.ownerId !== userId) {
    return null;
  }
  return observeProject(project);
}

export type CreateOwnedProjectResult =
  | { status: 'created'; project: ProjectSummary }
  | { status: 'limit' };

export function createOwnedProject(
  userId: string,
  name: string,
  options: { creationKey?: string | null; runtime?: ProjectRuntimeConfig | null } = {},
): CreateOwnedProjectResult {
  // Same key always returns the same project identity; a retry never creates a second project.
  if (options.creationKey !== null && options.creationKey !== undefined) {
    const existingId = creationKeys.get(`${userId}\0${options.creationKey}`);
    const existing =
      existingId === undefined
        ? undefined
        : projects.find((item) => item.id === existingId && item.ownerId === userId);
    if (existing !== undefined) {
      return { status: 'created', project: toSummary(existing) };
    }
  }
  const ownedCount = projects.filter((project) => project.ownerId === userId).length;
  if (ownedCount >= PROJECT_LIMIT) {
    return { status: 'limit' };
  }
  const runtime = options.runtime ?? null;
  nextProjectSeq += 1;
  const project: MockProject = {
    id: `prj-${nextProjectSeq}`,
    ownerId: userId,
    name,
    state: 'CREATING',
    createdAt: new Date().toISOString(),
    failureReason: null,
    observeCount: 0,
    runtime,
    creationKey: options.creationKey ?? null,
    // The mock applies the exact port group without a real cluster: port-bearing projects
    // keep the ASSIGNED verdict the real gateway would have confirmed.
    endpointState: runtime !== null && runtime.publicPorts.length > 0 ? 'ASSIGNED' : 'NONE',
  };
  projects.push(project);
  if (project.creationKey !== null) {
    creationKeys.set(`${userId}\0${project.creationKey}`, project.id);
  }
  ensureWorkspace(project.id);
  return { status: 'created', project: toSummary(project) };
}

/** Same key always resolves the same project identity for the same owner. */
export function findOwnedProjectCreation(
  userId: string,
  creationKey: string,
): ProjectSummary | null {
  const projectId = creationKeys.get(`${userId}\0${creationKey}`);
  if (projectId === undefined) {
    return null;
  }
  const project = projects.find((candidate) => candidate.id === projectId);
  return project === undefined ? null : observeProject(project);
}

export function removeOwnedProject(userId: string, projectId: string): void {
  const project = projects.find((item) => item.id === projectId && item.ownerId === userId);
  if (!project) return;
  if (project.creationKey !== null) {
    creationKeys.delete(`${userId}\0${project.creationKey}`);
  }
  removeProjectRuns(projectId);
  removeWorkspace(projectId);
  projects = projects.filter((item) => item !== project);
}

// ---------------------------------------------------------------------------
// Python dependency mock (design 6.1): one identity per change, a durable
// status answer for lost responses and one reconcile entry. The mock mirrors
// the backend contract; it never proves a real uv run works.
// ---------------------------------------------------------------------------

export const MOCK_DEPENDENCY_RECONCILIATION_FAILURE = 'WORKSPACE_RECONCILIATION_REQUIRED';

const PYPROJECT_PATH = 'pyproject.toml';
const UV_LOCK_PATH = 'uv.lock';

export type MockDependencyScenario = 'normal' | 'lost-response' | 'resolution-failed';

const DEPENDENCY_SCENARIOS: ReadonlySet<string> = new Set([
  'normal',
  'lost-response',
  'resolution-failed',
]);

export function isDependencyScenario(value: unknown): value is MockDependencyScenario {
  return typeof value === 'string' && DEPENDENCY_SCENARIOS.has(value);
}

export function setDependencyScenario(scenario: MockDependencyScenario): void {
  dependencyScenario = scenario;
}

export function getDependencyScenario(): MockDependencyScenario {
  return dependencyScenario;
}

export type MockDependencyOperation = {
  operationId: string;
  projectId: string;
  fingerprint: string;
  action: 'ADD' | 'REMOVE';
  packageName: string;
  version: string | null;
  state: 'PENDING' | 'COMMITTED';
  resultWorkspaceRevision: string | null;
};

/** Same normalization as the backend: lowercase and fold [-_.] runs to '-'. */
export function normalizeMockPackageName(packageName: string): string {
  return packageName.toLowerCase().replace(/[-_.]+/g, '-');
}

export function isValidMockPackageName(packageName: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?$/.test(packageName);
}

export function isValidMockPackageVersion(version: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z.+!-]{0,127}$/.test(version);
}

/** Mock stand-in for the backend's fixed-field-order request digest. */
export function mockDependencyRequestFingerprint(
  projectId: string,
  action: string,
  packageName: string,
  version: string | null,
  expectedRevision: string,
): string {
  return [projectId, action, packageName, version ?? '', expectedRevision].join('\u0000');
}

function pyprojectPackages(projectId: string): string[] {
  const content = getMockFile(projectId, PYPROJECT_PATH)?.textContent ?? null;
  if (content === null) {
    return [];
  }
  const match = /dependencies\s*=\s*\[([^\]]*)\]/.exec(content);
  if (match === null) {
    return [];
  }
  return (match[1] ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ''))
    .filter((entry) => entry !== '');
}

function writeDependencyFiles(projectId: string, packages: string[]): void {
  const pyproject =
    '[project]\nname = "manao-project"\nversion = "0.1.0"\nrequires-python = ">=3.13"\n'
    + `dependencies = [${packages.map((pkg) => `"${pkg}"`).join(', ')}]\n`;
  const lock = packages
    .map((pkg) => `[[package]]\nname = "${pkg}"\nversion = "1.0.0"\n`)
    .join('\n');
  ensureDependencyFile(projectId, PYPROJECT_PATH, pyproject);
  ensureDependencyFile(projectId, UV_LOCK_PATH, lock);
}

function ensureDependencyFile(projectId: string, path: string, content: string): void {
  if (getMockFile(projectId, path) === null) {
    const created = createMockEntry(projectId, 'file', path);
    if (!created.ok) {
      throw new Error(`mock dependency fixture cannot create ${path}`);
    }
  }
  const saved = saveMockFile(projectId, path, content);
  if (!saved.ok) {
    throw new Error(`mock dependency fixture cannot save ${path}`);
  }
}

/** Applies the uv add/remove result to the two managed files and returns the new revision. */
export function applyMockDependencyChange(
  projectId: string,
  action: 'ADD' | 'REMOVE',
  packageName: string,
  version: string | null,
): string {
  const name = normalizeMockPackageName(packageName);
  const current = pyprojectPackages(projectId);
  let next: string[];
  if (action === 'ADD') {
    const entry = version === null ? name : `${name}==${version}`;
    next = [...current.filter((pkg) => pkg.split('==')[0] !== name), entry];
  } else {
    next = current.filter((pkg) => pkg.split('==')[0] !== name);
  }
  writeDependencyFiles(projectId, next);
  return getWorkspaceRevision(projectId);
}

export function findMockDependencyOperation(
  projectId: string,
  operationId: string,
): MockDependencyOperation | null {
  return (
    dependencyOperations.find(
      (operation) => operation.projectId === projectId && operation.operationId === operationId,
    ) ?? null
  );
}

export function registerMockDependencyOperation(options: {
  projectId: string;
  operationId: string;
  fingerprint: string;
  action: 'ADD' | 'REMOVE';
  packageName: string;
  version: string | null;
}): MockDependencyOperation {
  const operation: MockDependencyOperation = {
    ...options,
    state: 'PENDING',
    resultWorkspaceRevision: null,
  };
  dependencyOperations.push(operation);
  return operation;
}

/** Drives the same registered commit once: apply the change, lift the failure, keep the identity. */
export function commitMockDependencyOperation(operation: MockDependencyOperation): MockDependencyOperation {
  if (operation.state === 'COMMITTED') {
    return operation;
  }
  const revision = applyMockDependencyChange(
    operation.projectId,
    operation.action,
    operation.packageName,
    operation.version,
  );
  operation.state = 'COMMITTED';
  operation.resultWorkspaceRevision = revision;
  const project = projects.find((candidate) => candidate.id === operation.projectId);
  if (project !== undefined && project.failureReason === MOCK_DEPENDENCY_RECONCILIATION_FAILURE) {
    project.state = 'READY';
    project.failureReason = null;
  }
  return operation;
}

export function listPendingMockDependencyOperations(projectId: string): MockDependencyOperation[] {
  return dependencyOperations.filter(
    (operation) => operation.projectId === projectId && operation.state === 'PENDING',
  );
}

/**
 * Test fixture: a dependency commit whose result is unknown failed the project with exactly
 * this operation's reconciliation failure and left the operation PENDING.
 */
export function markMockProjectDependencyReconciliationFailed(
  projectId: string,
  operationId: string,
  options: { action?: 'ADD' | 'REMOVE'; packageName?: string } = {},
): void {
  const project = projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    throw new Error(`mock project ${projectId} does not exist`);
  }
  const action = options.action ?? 'ADD';
  const packageName = options.packageName ?? 'httpx';
  registerMockDependencyOperation({
    projectId,
    operationId,
    fingerprint: mockDependencyRequestFingerprint(
      projectId,
      action,
      packageName,
      null,
      getWorkspaceRevision(projectId),
    ),
    action,
    packageName,
    version: null,
  });
  project.state = 'FAILED';
  project.failureReason = MOCK_DEPENDENCY_RECONCILIATION_FAILURE;
}
