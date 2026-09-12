import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CleanupEntry, CleanupTransport, ProjectView } from '../support/stage6-cleanup/contracts.ts';
import { DEFAULT_CLEANUP_POLICY } from '../support/stage6-cleanup/contracts.ts';
import { FileCleanupLedger } from '../support/stage6-cleanup/ledger.ts';
import { applyResume, createTestResources, inspectResume } from '../support/stage6-cleanup/runtime.ts';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function transport(projects: ProjectView[], deleted: string[]): CleanupTransport {
  return {
    verifyOwner: vi.fn().mockResolvedValue(undefined),
    createProject: vi.fn(async (_owner, name) => {
      const project: ProjectView = {
        id: 'p-' + name.slice(-8),
        name,
        state: 'READY',
        createdAt: '2026-09-10T00:00:00.000Z',
      };
      projects.push(project);
      return project;
    }),
    listProjects: vi.fn(async () => projects),
    getProject: vi.fn(async (_owner, projectId) => {
      if (deleted.includes(projectId)) {
        return { status: 404 as const };
      }
      const project = projects.find((item) => item.id === projectId);
      return project === undefined ? { status: 404 as const } : { status: 200 as const, project };
    }),
    deleteProject: vi.fn(async (_owner, projectId) => {
      deleted.push(projectId);
      return { status: 204 as const };
    }),
    getActiveRun: vi.fn().mockResolvedValue(null),
    stopRun: vi.fn(),
  };
}

describe('stage6 resource fixtures', () => {
  it('does not let one test finish delete another test project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stage6-fix-'));
    dirs.push(root);
    const ledger = new FileCleanupLedger(root, 'inv-1');
    const projects: ProjectView[] = [];
    const deleted: string[] = [];
    const shared = transport(projects, deleted);
    const first = await createTestResources({
      invocationId: 'inv-1', testId: 'test-a', attempt: 0, workerKey: '1',
      ownerIds: { alice: 'owner-a' }, ledger, transport: shared, policy: DEFAULT_CLEANUP_POLICY,
      clock: { now: () => Date.parse('2026-09-10T00:00:00.000Z'), sleep: async () => {} },
    });
    const second = await createTestResources({
      invocationId: 'inv-1', testId: 'test-b', attempt: 0, workerKey: '1',
      ownerIds: { alice: 'owner-a' }, ledger, transport: shared, policy: DEFAULT_CLEANUP_POLICY,
      clock: { now: () => Date.parse('2026-09-10T00:00:00.000Z'), sleep: async () => {} },
    });
    const a = await first.createProject('alice', 'one');
    const b = await second.createProject('alice', 'two');
    await first.finish();
    expect(deleted).toContain(a.id);
    expect(deleted).not.toContain(b.id);
    await second.finish();
    expect(deleted).toContain(b.id);
  });

  it('releases both projects created by the same test', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stage6-fix-'));
    dirs.push(root);
    const ledger = new FileCleanupLedger(root, 'inv-1');
    const projects: ProjectView[] = [];
    const deleted: string[] = [];
    const resources = await createTestResources({
      invocationId: 'inv-1', testId: 'two-projects', attempt: 0, workerKey: '1',
      ownerIds: { alice: 'owner-a' }, ledger, transport: transport(projects, deleted),
      policy: DEFAULT_CLEANUP_POLICY,
      clock: { now: () => Date.parse('2026-09-10T00:00:00.000Z'), sleep: async () => {} },
    });
    const first = await resources.createProject('alice', 'a');
    const second = await resources.createProject('alice', 'b');
    await resources.finish();
    expect(deleted).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it('inspects a leftover ledger with zero network and apply resumes only that invocation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stage6-fix-'));
    dirs.push(root);
    const ledger = new FileCleanupLedger(root, 'inv-1');
    const leftover: CleanupEntry = {
      schemaVersion: 1, invocationId: 'inv-1', testId: 'old', attempt: 0, workerKey: '9',
      entryId: 'old-entry', ownerId: 'owner-a', ownerKey: 'alice',
      exactName: 'stage6-left', preparedAt: '2026-09-10T00:00:00.000Z',
      projectId: 'p-left', runIds: [], state: 'OWNED', issueCodes: [],
    };
    await ledger.write(leftover);
    const inspected = await inspectResume(ledger, 'inv-1');
    expect(inspected.actions.length).toBe(1);
    const deleted: string[] = [];
    const report = await applyResume(
      ledger,
      'inv-1',
      transport([{ id: 'p-left', name: 'stage6-left', state: 'READY', createdAt: leftover.preparedAt }], deleted),
      { now: () => Date.parse(leftover.preparedAt), sleep: async () => {} },
      DEFAULT_CLEANUP_POLICY,
    );
    expect(deleted).toEqual(['p-left']);
    expect(report.entries[0]?.state).toBe('API_CLEANED');
  });

  it('claims a single hold slot across two workers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stage6-fix-'));
    dirs.push(root);
    const ledger = new FileCleanupLedger(root, 'inv-1');
    const wins = await Promise.all([
      ledger.claimHold('owner-a', 'held-name'),
      ledger.claimHold('owner-a', 'held-name'),
    ]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('keeps three e2e specs free of bare project POST/DELETE helpers', () => {
    for (const file of [
      'tests/e2e/stage6-real-backend.spec.ts',
      'tests/e2e/stage6-terminal-stress.spec.ts',
      'tests/e2e/stage6-faults.spec.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain("from '../support/stage6-cleanup/fixtures'");
      expect(source).not.toContain('createdProjectIds');
      expect(source).not.toMatch(/page\.request\.post\(['"`]\/api\/v1\/projects['"`]/);
      expect(source).not.toMatch(/request\.delete\(['"`]\/api\/v1\/projects\//);
    }
  });
});
