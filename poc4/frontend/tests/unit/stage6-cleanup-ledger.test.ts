import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CleanupEntry } from '../support/stage6-cleanup/contracts.ts';
import { FileCleanupLedger } from '../support/stage6-cleanup/ledger.ts';

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'stage6-ledger-'));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function entry(overrides: Partial<CleanupEntry> = {}): CleanupEntry {
  return {
    schemaVersion: 1,
    invocationId: 'inv-1',
    testId: 'case-1',
    attempt: 0,
    workerKey: 'worker-1',
    entryId: 'entry-1',
    ownerId: 'owner-a',
    ownerKey: 'alice',
    exactName: 'stage6-inv-1-case-1',
    preparedAt: '2026-09-10T00:00:00.000Z',
    projectId: null,
    runIds: [],
    state: 'PREPARED',
    issueCodes: [],
    ...overrides,
  };
}

describe('FileCleanupLedger', () => {
  it('persists an entry so a new instance can read it back', async () => {
    const root = await tempDir();
    const first = new FileCleanupLedger(root, 'inv-1');
    await first.write(entry({ projectId: 'p1', state: 'OWNED' }));
    const second = new FileCleanupLedger(root, 'inv-1');
    expect(await second.readAll()).toEqual([entry({ projectId: 'p1', state: 'OWNED' })]);
  });

  it('keeps a malformed sibling file from wiping valid entries', async () => {
    const root = await tempDir();
    const ledger = new FileCleanupLedger(root, 'inv-1');
    await ledger.write(entry());
    await writeFile(path.join(root, 'broken.json'), '{not-json', 'utf8');
    const rows = await ledger.readAll();
    expect(rows.some((row) => row.entryId === 'entry-1')).toBe(true);
    expect(rows.some((row) => row.state === 'UNRESOLVED' && row.issueCodes.includes('LEDGER_ENTRY_INVALID')))
      .toBe(true);
  });

  it('allows two tests to write distinct files in parallel', async () => {
    const root = await tempDir();
    const ledger = new FileCleanupLedger(root, 'inv-1');
    await Promise.all([
      ledger.write(entry({ entryId: 'entry-a', testId: 'a' })),
      ledger.write(entry({ entryId: 'entry-b', testId: 'b' })),
    ]);
    const ids = (await ledger.readAll()).map((row) => row.entryId).sort();
    expect(ids).toEqual(['entry-a', 'entry-b']);
  });

  it('rejects path traversal, other invocations, and symlink escape', async () => {
    const root = await tempDir();
    const ledger = new FileCleanupLedger(root, 'inv-1');
    await expect(ledger.write(entry({ entryId: '../escape' }))).rejects.toThrow(/ENTRY_PATH_REJECTED|entryId/);
    await expect(ledger.write(entry({ invocationId: 'inv-other' }))).rejects.toThrow(/INVOCATION/);
    const outside = await tempDir();
    await writeFile(path.join(outside, 'secret.json'), JSON.stringify(entry({ entryId: 'secret' })), 'utf8');
    try {
      await symlink(path.join(outside, 'secret.json'), path.join(root, 'secret.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }
    const rows = await ledger.readAll();
    expect(rows.some((row) => row.entryId === 'secret')).toBe(false);
  });

  it('claims a hold slot atomically for one exact name', async () => {
    const root = await tempDir();
    const ledger = new FileCleanupLedger(root, 'inv-1');
    const results = await Promise.all([
      ledger.claimHold('owner-a', 'held-name'),
      ledger.claimHold('owner-a', 'held-name'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ledger.claimHold('owner-a', 'other-name')).toBe(false);
  });

  it('does not treat manifest or teardown reports as cleanup entries', async () => {
    const root = await tempDir();
    const ledger = new FileCleanupLedger(root, 'inv-1');
    await ledger.write(entry({ projectId: 'p1', state: 'OWNED' }));
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      invocationId: 'inv-1',
      createdAt: '2026-09-12T00:00:00.000Z',
    }), 'utf8');
    await writeFile(path.join(root, 'teardown-report.json'), JSON.stringify({ entries: [], issues: [] }), 'utf8');
    const rows = await ledger.readAll();
    expect(rows.map((row) => row.entryId)).toEqual(['entry-1']);
  });

  it('never writes token or password fields', async () => {
    const root = await tempDir();
    const ledger = new FileCleanupLedger(root, 'inv-1');
    await ledger.write(entry({ projectId: 'p1' }));
    const raw = await readFile(path.join(root, 'entry-1.json'), 'utf8');
    expect(raw.toLowerCase()).not.toMatch(/token|password|kubeconfig|authorization/);
    expect(JSON.parse(raw)).not.toHaveProperty('accessToken');
  });
});
