import type {
  CleanupClock,
  CleanupEntry,
  CleanupLedger,
  CleanupPolicy,
  CleanupTransport,
  ProjectView,
  SweepReport,
} from './contracts.ts';

export class Stage6CleanupEngine {
  private readonly ledger: CleanupLedger;
  private readonly transport: CleanupTransport;
  private readonly clock: CleanupClock;
  private readonly policy: CleanupPolicy;

  constructor(
    ledger: CleanupLedger,
    transport: CleanupTransport,
    clock: CleanupClock,
    policy: CleanupPolicy,
  ) {
    this.ledger = ledger;
    this.transport = transport;
    this.clock = clock;
    this.policy = policy;
  }

  async createRegistered(entry: CleanupEntry): Promise<ProjectView> {
    await this.transport.verifyOwner(entry.ownerKey, entry.ownerId);
    await this.ledger.write(entry);
    try {
      const project = await this.transport.createProject(entry.ownerKey, entry.exactName);
      const owned: CleanupEntry = { ...entry, projectId: project.id, state: 'OWNED' };
      await this.ledger.write(owned);
      return project;
    } catch {
      const uncertain: CleanupEntry = {
        ...entry,
        state: 'CREATE_UNCERTAIN',
        issueCodes: [...entry.issueCodes, 'CREATE_RESPONSE_UNCERTAIN'],
      };
      await this.ledger.write(uncertain);
      return reconcileCreatedProject(
        uncertain,
        this.ledger,
        this.transport,
        this.clock,
        this.policy.createResolveMs,
      );
    }
  }

  async cleanupOne(entry: CleanupEntry): Promise<CleanupEntry> {
    if (entry.state === 'HELD' || entry.state === 'VERIFIED') {
      return entry;
    }
    const deadline = this.clock.now() + this.policy.projectDeadlineMs;
    await this.transport.verifyOwner(entry.ownerKey, entry.ownerId);
    let current = entry;
    if (current.projectId === null) {
      const project = await reconcileCreatedProject(
        current,
        this.ledger,
        this.transport,
        this.clock,
        Math.min(this.policy.createResolveMs, Math.max(0, deadline - this.clock.now())),
      );
      current = { ...current, projectId: project.id, state: 'OWNED' };
    }
    const projectId = current.projectId;
    if (projectId === null) {
      return this.unresolved(current, 'CREATE_IDENTITY_UNRESOLVED');
    }
    const first = await this.transport.getProject(current.ownerKey, projectId);
    if (first.status === 404) {
      return this.mark(current, 'API_CLEANED');
    }
    if (first.project.state === 'CREATING') {
      const creatingDeadline = Math.min(deadline, this.clock.now() + this.policy.creatingWaitMs);
      while (this.clock.now() < creatingDeadline) {
        await this.clock.sleep(Math.min(250, Math.max(0, creatingDeadline - this.clock.now())));
        const again = await this.transport.getProject(current.ownerKey, projectId);
        if (again.status === 404) {
          return this.mark(current, 'API_CLEANED');
        }
        if (again.project.state !== 'CREATING') {
          first.project.state = again.project.state;
          break;
        }
      }
      if (first.project.state === 'CREATING') {
        return this.unresolved(current, 'CREATE_STILL_CREATING');
      }
    }
    const runWait = await this.stopAndWaitForRecordedRun(current, projectId, deadline);
    if (runWait !== null) {
      return runWait;
    }
    const remaining = deadline - this.clock.now();
    if (remaining <= 0) {
      return this.unresolved(current, 'CLEANUP_DEADLINE');
    }
    const deleteTimeout = Math.min(this.policy.deleteRequestMs, remaining);
    try {
      const deleted = await this.transport.deleteProject(current.ownerKey, projectId, deleteTimeout);
      if (deleted.status === 409 && deleted.code === 'PROJECT_CREATING') {
        return this.unresolved(current, 'CREATE_STILL_CREATING');
      }
      if (deleted.status === 409) {
        return this.unresolved(current, deleted.code ?? 'PROJECT_BUSY');
      }
    } catch {
      // Confirm by GET before treating the delete as complete.
    }
    const after = await this.transport.getProject(current.ownerKey, projectId);
    if (after.status === 404) {
      return this.mark(current, 'API_CLEANED');
    }
    if (after.project.state === 'DELETING') {
      return this.unresolved(current, 'CLEANUP_INCOMPLETE');
    }
    return this.unresolved(current, 'CLEANUP_REQUEST_FAILED');
  }

  async sweep(): Promise<SweepReport> {
    const snapshot = await this.ledger.readAll();
    const entries: CleanupEntry[] = [];
    const issues: SweepReport['issues'] = [];
    for (const entry of snapshot) {
      try {
        entries.push(await this.cleanupOne(entry));
      } catch {
        let latest = entry;
        try {
          latest = (await this.ledger.readAll()).find((row) => row.entryId === entry.entryId) ?? entry;
        } catch {
          issues.push({ entryId: entry.entryId, code: 'LEDGER_READ_FAILED' });
        }
        const failed: CleanupEntry = {
          ...latest,
          state: 'UNRESOLVED',
          issueCodes: [...latest.issueCodes, 'CLEANUP_REQUEST_FAILED'],
        };
        entries.push(failed);
        try {
          await this.ledger.write(failed);
        } catch {
          issues.push({ entryId: entry.entryId, code: 'LEDGER_WRITE_FAILED' });
        }
      }
    }
    return { entries, issues };
  }

  private async stopAndWaitForRecordedRun(
    current: CleanupEntry,
    projectId: string,
    deadline: number,
  ): Promise<CleanupEntry | null> {
    let active = await this.transport.getActiveRun(current.ownerKey, projectId);
    if (active === null) {
      return null;
    }
    if (!this.policy.allowStopRecordedRuns || !current.runIds.includes(active.id)) {
      return this.unresolved(current, 'UNKNOWN_ACTIVE_RUN');
    }
    await this.transport.stopRun(current.ownerKey, projectId, active.id);
    while (this.clock.now() < deadline) {
      await this.clock.sleep(Math.min(250, Math.max(0, deadline - this.clock.now())));
      active = await this.transport.getActiveRun(current.ownerKey, projectId);
      if (active === null) {
        return null;
      }
      if (!current.runIds.includes(active.id)) {
        return this.unresolved(current, 'UNKNOWN_ACTIVE_RUN');
      }
    }
    return this.unresolved(current, 'RUN_STILL_ACTIVE');
  }

  private async mark(entry: CleanupEntry, state: CleanupEntry['state']): Promise<CleanupEntry> {
    const next: CleanupEntry = { ...entry, state };
    await this.ledger.write(next);
    return next;
  }

  private async unresolved(entry: CleanupEntry, code: string): Promise<CleanupEntry> {
    const next: CleanupEntry = {
      ...entry,
      state: 'UNRESOLVED',
      issueCodes: [...entry.issueCodes, code],
    };
    await this.ledger.write(next);
    return next;
  }
}

async function reconcileCreatedProject(
  entry: CleanupEntry,
  ledger: CleanupLedger,
  transport: CleanupTransport,
  clock: CleanupClock,
  resolveMs: number,
): Promise<ProjectView> {
  const deadline = clock.now() + resolveMs;
  const earliest = Date.parse(entry.preparedAt) - 5000;
  let unavailable = false;
  while (clock.now() < deadline) {
    await transport.verifyOwner(entry.ownerKey, entry.ownerId);
    let projects: ProjectView[];
    try {
      projects = await transport.listProjects(entry.ownerKey);
    } catch {
      unavailable = true;
      await clock.sleep(Math.min(250, Math.max(0, deadline - clock.now())));
      continue;
    }
    const matches = projects.filter((project) =>
      project.name === entry.exactName
      && Date.parse(project.createdAt) >= earliest
      && Date.parse(project.createdAt) <= clock.now() + 5000
    );
    if (matches.length > 1) {
      await ledger.write({
        ...entry,
        state: 'UNRESOLVED',
        issueCodes: [...entry.issueCodes, 'CREATE_IDENTITY_AMBIGUOUS'],
      });
      throw new Error('CREATE_IDENTITY_AMBIGUOUS');
    }
    if (matches.length === 1) {
      const project = matches[0];
      await ledger.write({ ...entry, projectId: project.id, state: 'OWNED' });
      return project;
    }
    await clock.sleep(Math.min(250, Math.max(0, deadline - clock.now())));
  }
  const code = unavailable ? 'CREATE_RECONCILIATION_UNAVAILABLE' : 'CREATE_IDENTITY_UNRESOLVED';
  await ledger.write({ ...entry, state: 'UNRESOLVED', issueCodes: [...entry.issueCodes, code] });
  throw new Error(code);
}
