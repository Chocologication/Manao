import type { AuthUser, LoginResponse } from '../contracts/auth';
import type { ProjectState, ProjectSummary } from '../contracts/project';
import { clearLargeFileBodyCache, ensureWorkspace, resetWorkspaces } from './fileFixtures';
import { resetLogTickets } from './runSocket';
import { bootRunState, resetRunState } from './runState';

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const PROJECT_LIMIT = 3;

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
let nextProjectSeq = 0;
let nextTokenSeq = 0;
let fileRequestCounts = new Map<string, number>();
let largeFileBodiesEnabled = false;
let writeScenario: WriteScenario = 'normal';
let resetTerminalMockState = (): void => undefined;

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
  return {
    id: project.id,
    name: project.name,
    state: project.state,
    createdAt: project.createdAt,
    failureReason: project.failureReason,
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
    },
    {
      id: BOB_SEED_PROJECT_ID,
      ownerId: 'usr-bob',
      name: 'Bob Lab',
      state: 'READY',
      createdAt: '2026-08-21T00:00:01.000Z',
      failureReason: null,
      observeCount: 0,
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
  nextProjectSeq = 0;
  nextTokenSeq = 0;
  projects = seedProjects();
  fileRequestCounts = new Map();
  largeFileBodiesEnabled = false;
  writeScenario = 'normal';
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

export function createOwnedProject(userId: string, name: string): CreateOwnedProjectResult {
  const ownedCount = projects.filter((project) => project.ownerId === userId).length;
  if (ownedCount >= PROJECT_LIMIT) {
    return { status: 'limit' };
  }
  nextProjectSeq += 1;
  const project: MockProject = {
    id: `prj-${nextProjectSeq}`,
    ownerId: userId,
    name,
    state: 'CREATING',
    createdAt: new Date().toISOString(),
    failureReason: null,
    observeCount: 0,
  };
  projects.push(project);
  ensureWorkspace(project.id);
  return { status: 'created', project: toSummary(project) };
}
