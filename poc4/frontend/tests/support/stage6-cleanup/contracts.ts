export type CleanupState =
  | 'PREPARED'
  | 'OWNED'
  | 'CREATE_UNCERTAIN'
  | 'API_CLEANED'
  | 'HELD'
  | 'UNRESOLVED'
  | 'VERIFIED';

export type CleanupEntry = {
  schemaVersion: 1;
  invocationId: string;
  testId: string;
  attempt: number;
  workerKey: string;
  entryId: string;
  ownerId: string;
  ownerKey: string;
  exactName: string;
  preparedAt: string;
  projectId: string | null;
  runIds: string[];
  state: CleanupState;
  issueCodes: string[];
};

export interface CleanupLedger {
  write(entry: CleanupEntry): Promise<void>;
  readAll(): Promise<CleanupEntry[]>;
}

export type ProjectView = {
  id: string;
  name: string;
  state: 'CREATING' | 'READY' | 'FAILED' | 'DELETING';
  createdAt: string;
};

export type ReadProject = { status: 200; project: ProjectView } | { status: 404 };

export type DeleteProject = { status: 204 | 404 | 409 | 503; code?: string };

export interface CleanupTransport {
  verifyOwner(ownerKey: string, expectedOwnerId: string): Promise<void>;
  createProject(ownerKey: string, exactName: string): Promise<ProjectView>;
  listProjects(ownerKey: string): Promise<ProjectView[]>;
  getProject(ownerKey: string, projectId: string): Promise<ReadProject>;
  deleteProject(ownerKey: string, projectId: string, timeoutMs: number): Promise<DeleteProject>;
  getActiveRun(ownerKey: string, projectId: string): Promise<{ id: string; state: string } | null>;
  stopRun(ownerKey: string, projectId: string, runId: string): Promise<void>;
}

export interface CleanupClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type CleanupPolicy = {
  createResolveMs: number;
  creatingWaitMs: number;
  projectDeadlineMs: number;
  deleteRequestMs: number;
  allowStopRecordedRuns: boolean;
};

export type SweepReport = {
  entries: CleanupEntry[];
  issues: { entryId: string; code: string }[];
};

export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = {
  createResolveMs: 30_000,
  creatingWaitMs: 180_000,
  projectDeadlineMs: 300_000,
  deleteRequestMs: 110_000,
  allowStopRecordedRuns: true,
};
