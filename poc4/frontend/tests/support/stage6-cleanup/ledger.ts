import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CleanupEntry, CleanupLedger } from './contracts.ts';

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SKIP_JSON = new Set(['hold.json', 'manifest.json', 'teardown-report.json']);
const STATES = new Set([
  'PREPARED',
  'OWNED',
  'CREATE_UNCERTAIN',
  'API_CLEANED',
  'HELD',
  'UNRESOLVED',
  'VERIFIED',
]);

export class FileCleanupLedger implements CleanupLedger {
  private readonly rootDir: string;
  private readonly invocationId: string;

  constructor(rootDir: string, invocationId: string) {
    this.rootDir = path.resolve(rootDir);
    this.invocationId = invocationId;
  }

  async write(entry: CleanupEntry): Promise<void> {
    this.assertEntry(entry);
    await mkdir(this.rootDir, { recursive: true });
    const target = await this.verifiedFile(entry.entryId + '.json', false);
    const payload = JSON.stringify(entry);
    if (/token|password|kubeconfig|authorization/i.test(payload)) {
      throw new Error('LEDGER_SECRET_REJECTED');
    }
    const temp = await this.verifiedFile(entry.entryId + '.' + randomUUID() + '.tmp', false);
    await writeFile(temp, payload, 'utf8');
    await rename(temp, target);
  }

  async readAll(): Promise<CleanupEntry[]> {
    await mkdir(this.rootDir, { recursive: true });
    const names = await readdir(this.rootDir);
    const rows: CleanupEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || SKIP_JSON.has(name)) {
        continue;
      }
      let file: string;
      try {
        file = await this.verifiedFile(name, true);
      } catch {
        continue;
      }
      const raw = await readFile(file, 'utf8');
      try {
        const parsed = JSON.parse(raw) as CleanupEntry;
        this.assertEntry(parsed);
        rows.push(parsed);
      } catch {
        rows.push({
          schemaVersion: 1,
          invocationId: this.invocationId,
          testId: 'unknown',
          attempt: 0,
          workerKey: 'unknown',
          entryId: name.replace(/\.json$/, ''),
          ownerId: 'unknown',
          ownerKey: 'unknown',
          exactName: 'unknown',
          preparedAt: new Date(0).toISOString(),
          projectId: null,
          runIds: [],
          state: 'UNRESOLVED',
          issueCodes: ['LEDGER_ENTRY_INVALID'],
        });
      }
    }
    return rows;
  }

  async claimHold(ownerId: string, exactName: string): Promise<boolean> {
    await mkdir(this.rootDir, { recursive: true });
    const holdPath = path.join(this.rootDir, 'hold.json');
    try {
      const handle = await open(holdPath, 'wx');
      await handle.writeFile(JSON.stringify({ ownerId, exactName, invocationId: this.invocationId }), 'utf8');
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }

  private assertEntry(entry: CleanupEntry): void {
    if (entry.schemaVersion !== 1) {
      throw new Error('LEDGER_SCHEMA_REJECTED');
    }
    if (entry.invocationId !== this.invocationId) {
      throw new Error('INVOCATION_MISMATCH');
    }
    if (!SAFE_ID.test(entry.entryId)) {
      throw new Error('ENTRY_PATH_REJECTED');
    }
    if (!STATES.has(entry.state)) {
      throw new Error('LEDGER_STATE_REJECTED');
    }
  }

  private async verifiedFile(name: string, mustExist: boolean): Promise<string> {
    if (name.includes('..') || name.includes(path.sep) || name.includes('/') || name.includes('\\')) {
      throw new Error('ENTRY_PATH_REJECTED');
    }
    const candidate = path.resolve(this.rootDir, name);
    if (candidate !== this.rootDir && !candidate.startsWith(this.rootDir + path.sep)) {
      throw new Error('ENTRY_PATH_REJECTED');
    }
    try {
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) {
        throw new Error('ENTRY_PATH_REJECTED');
      }
      const realRoot = await realpath(this.rootDir);
      const realFile = await realpath(candidate);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
        throw new Error('ENTRY_PATH_REJECTED');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (mustExist) {
          throw error;
        }
        return candidate;
      }
      throw error;
    }
    return candidate;
  }
}
