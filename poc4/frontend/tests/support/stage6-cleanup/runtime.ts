import type {
  CleanupClock,
  CleanupEntry,
  CleanupLedger,
  CleanupPolicy,
  CleanupTransport,
  ProjectView,
  SweepReport,
} from './contracts.ts';
import { DEFAULT_CLEANUP_POLICY } from './contracts.ts';
import { Stage6CleanupEngine } from './engine.ts';

export interface Stage6Resources {
  createProject(ownerKey: string, caseKey: string): Promise<ProjectView>;
  recordRun(projectId: string, runId: string): Promise<void>;
  finish(): Promise<SweepReport>;
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

  return {
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
        entryId: sanitize(input.testId + '-' + caseKey + '-' + String(input.attempt)),
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
