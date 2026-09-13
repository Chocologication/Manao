import { createHash } from 'node:crypto';
import type {
  CleanupClock,
  CleanupEntry,
  CleanupLedger,
  CleanupPolicy,
  CleanupTransport,
  DeleteProject,
  ProjectView,
  ReadProject,
  SweepReport,
} from './contracts.ts';
import { DEFAULT_CLEANUP_POLICY } from './contracts.ts';
import { Stage6CleanupEngine } from './engine.ts';
import { HttpCleanupTransport } from './http-transport.ts';

export interface Stage6Resources {
  createProject(ownerKey: string, caseKey: string): Promise<ProjectView>;
  recordRun(projectId: string, runId: string): Promise<void>;
  waitReady(ownerKey: string, projectId: string): Promise<string>;
  getProject(ownerKey: string, projectId: string): Promise<ReadProject>;
  listProjects(ownerKey: string): Promise<ProjectView[]>;
  deleteProject(ownerKey: string, projectId: string, timeoutMs?: number): Promise<DeleteProject>;
  sweep(): Promise<SweepReport>;
  finish(): Promise<SweepReport>;
  http: HttpCleanupTransport | null;
}

export class ScopedCleanupLedger implements CleanupLedger {
  private readonly inner: CleanupLedger;
  private readonly invocationId: string;
  private readonly testId: string;
  private readonly workerKey: string;

  constructor(inner: CleanupLedger, invocationId: string, testId: string, workerKey: string) {
    this.inner = inner;
    this.invocationId = invocationId;
    this.testId = testId;
    this.workerKey = workerKey;
  }

  async write(entry: CleanupEntry): Promise<void> {
    if (entry.invocationId !== this.invocationId || entry.testId !== this.testId || entry.workerKey !== this.workerKey) {
      throw new Error('LEDGER_SCOPE_REJECTED');
    }
    await this.inner.write(entry);
  }

  async readAll(): Promise<CleanupEntry[]> {
    return (await this.inner.readAll()).filter((entry) =>
      entry.invocationId === this.invocationId
      && entry.testId === this.testId
      && entry.workerKey === this.workerKey);
  }
}

export type ResourceFactoryInput = {
  invocationId: string;
  testId: string;
  attempt: number;
  workerKey: string;
  ownerIds: Record<string, string>;
  ledger: CleanupLedger;
  transport: CleanupTransport;
  clock?: CleanupClock;
  policy?: CleanupPolicy;
};

export async function createTestResources(input: ResourceFactoryInput): Promise<Stage6Resources> {
  const scoped = new ScopedCleanupLedger(input.ledger, input.invocationId, input.testId, input.workerKey);
  const clock = input.clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  const policy = input.policy ?? DEFAULT_CLEANUP_POLICY;
  const engine = new Stage6CleanupEngine(scoped, input.transport, clock, policy);
  const entries = new Map<string, CleanupEntry>();
  const http = input.transport instanceof HttpCleanupTransport ? input.transport : null;

  return {
    http,
    async createProject(ownerKey, caseKey) {
      const ownerId = input.ownerIds[ownerKey];
      if (ownerId === undefined) {
        throw new Error('UNKNOWN_OWNER_KEY');
      }
      const exactName = ['stage6', input.invocationId.slice(0, 8), sanitize(input.testId), sanitize(caseKey), String(input.attempt)]
        .join('-')
        .slice(0, 160);
      const prepared: CleanupEntry = {
        schemaVersion: 1,
        invocationId: input.invocationId,
        testId: input.testId,
        attempt: input.attempt,
        workerKey: input.workerKey,
        entryId: uniqueEntryId(input.testId, caseKey, input.attempt, entries.size),
        ownerId,
        ownerKey,
        exactName,
        preparedAt: new Date(clock.now()).toISOString(),
        projectId: null,
        runIds: [],
        state: 'PREPARED',
        issueCodes: [],
      };
      const project = await engine.createRegistered(prepared);
      entries.set(project.id, { ...prepared, projectId: project.id, state: 'OWNED' });
      return project;
    },
    async recordRun(projectId, runId) {
      const current = entries.get(projectId);
      if (current === undefined) {
        throw new Error('UNKNOWN_PROJECT');
      }
      const updated: CleanupEntry = { ...current, runIds: [...current.runIds, runId] };
      entries.set(projectId, updated);
      await scoped.write(updated);
    },
    async waitReady(ownerKey, projectId) {
      const deadline = clock.now() + policy.creatingWaitMs;
      while (clock.now() <= deadline) {
        const read = await input.transport.getProject(ownerKey, projectId);
        if (read.status === 404) {
          throw new Error('PROJECT_NOT_FOUND');
        }
        if (read.project.state !== 'CREATING') {
          return read.project.state;
        }
        await clock.sleep(Math.min(2000, Math.max(0, deadline - clock.now())));
      }
      throw new Error('CREATE_STILL_CREATING');
    },
    async getProject(ownerKey, projectId) {
      return input.transport.getProject(ownerKey, projectId);
    },
    async listProjects(ownerKey) {
      return input.transport.listProjects(ownerKey);
    },
    async deleteProject(ownerKey, projectId, timeoutMs) {
      return input.transport.deleteProject(ownerKey, projectId, timeoutMs ?? policy.deleteRequestMs);
    },
    async sweep() {
      return engine.sweep();
    },
    async finish() {
      return engine.sweep();
    },
  };
}

export type ResumeInspect = {
  invocationId: string;
  entries: CleanupEntry[];
  actions: string[];
};

export async function inspectResume(ledger: CleanupLedger, invocationId: string): Promise<ResumeInspect> {
  const entries = (await ledger.readAll()).filter((entry) => entry.invocationId === invocationId);
  return {
    invocationId,
    entries,
    actions: entries
      .filter((entry) => entry.state !== 'VERIFIED' && entry.state !== 'API_CLEANED')
      .map((entry) => 'resume ' + entry.entryId + ' state=' + entry.state),
  };
}

export async function applyResume(
  ledger: CleanupLedger,
  invocationId: string,
  transport: CleanupTransport,
  clock: CleanupClock,
  policy: CleanupPolicy,
): Promise<SweepReport> {
  const scoped = new InvocationLedger(ledger, invocationId);
  return new Stage6CleanupEngine(scoped, transport, clock, policy).sweep();
}

class InvocationLedger implements CleanupLedger {
  private readonly inner: CleanupLedger;
  private readonly invocationId: string;

  constructor(inner: CleanupLedger, invocationId: string) {
    this.inner = inner;
    this.invocationId = invocationId;
  }

  async write(entry: CleanupEntry): Promise<void> {
    if (entry.invocationId !== this.invocationId) {
      throw new Error('INVOCATION_MISMATCH');
    }
    await this.inner.write(entry);
  }

  async readAll(): Promise<CleanupEntry[]> {
    return (await this.inner.readAll()).filter((entry) => entry.invocationId === this.invocationId);
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
}

function uniqueEntryId(testId: string, caseKey: string, attempt: number, seq: number): string {
  const digest = createHash('sha256')
    .update([testId, caseKey, String(attempt), String(seq)].join('\0'))
    .digest('hex')
    .slice(0, 12);
  return [sanitize(caseKey), String(attempt), String(seq), digest].join('-');
}
