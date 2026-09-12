import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { DEFAULT_CLEANUP_POLICY } from './contracts.ts';
import { Stage6CleanupEngine } from './engine.ts';
import { HttpCleanupTransport } from './http-transport.ts';
import { FileCleanupLedger } from './ledger.ts';

export default async function globalTeardown(_config: FullConfig): Promise<void> {
  const invocationId = process.env.STAGE6_INVOCATION_ID;
  const root = process.env.STAGE6_CLEANUP_LEDGER_DIR;
  if (invocationId === undefined || root === undefined) {
    return;
  }
  const ledger = new FileCleanupLedger(root, invocationId);
  const baseUrl = process.env.STAGE6_API_BASE_URL ?? 'http://127.0.0.1:4173';
  const transport = new HttpCleanupTransport({
    baseUrl,
    async login(ownerKey) {
      const username = ownerKey === 'bob'
        ? (process.env.STAGE6_BOB_USERNAME ?? 'bob')
        : (process.env.STAGE6_ALICE_USERNAME ?? 'alice');
      const password = ownerKey === 'bob'
        ? (process.env.STAGE6_BOB_PASSWORD ?? 'stage6-bob-pass')
        : (process.env.STAGE6_ALICE_PASSWORD ?? 'stage6-alice-pass');
      const response = await fetch(baseUrl + '/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        throw new Error('AUTH_FAILED');
      }
      const body = (await response.json()) as { accessToken: string; user: { id: string } };
      return { accessToken: body.accessToken, userId: body.user.id };
    },
  });
  const engine = new Stage6CleanupEngine(
    ledger,
    transport,
    { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    DEFAULT_CLEANUP_POLICY,
  );
  const report = await engine.sweep();
  await writeFile(path.join(root, 'teardown-report.json'), JSON.stringify(report, null, 2), 'utf8');
  const incomplete = report.entries.filter((entry) => entry.state !== 'API_CLEANED' && entry.state !== 'VERIFIED');
  if (report.issues.length > 0 || incomplete.length > 0) {
    throw new Error('STAGE6_CLEANUP_INCOMPLETE');
  }
}
