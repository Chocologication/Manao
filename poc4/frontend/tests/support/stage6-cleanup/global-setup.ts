import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const invocationId = process.env.STAGE6_INVOCATION_ID ?? randomUUID();
  process.env.STAGE6_INVOCATION_ID = invocationId;
  const root = process.env.STAGE6_CLEANUP_LEDGER_DIR
    ?? path.resolve('test-results', 'stage6-cleanup', invocationId);
  await mkdir(root, { recursive: true });
  process.env.STAGE6_CLEANUP_LEDGER_DIR = root;
  const manifestPath = path.join(root, 'manifest.json');
  let existing: { invocationId?: string } | null = null;
  try {
    existing = JSON.parse(await readFile(manifestPath, 'utf8')) as { invocationId?: string };
  } catch {
    existing = null;
  }
  if (existing?.invocationId !== undefined && existing.invocationId !== invocationId) {
    throw new Error('STAGE6_MANIFEST_INVOCATION_MISMATCH');
  }
  if (existing === null) {
    const manifest = {
      schemaVersion: 1,
      invocationId,
      codeSha: createHash('sha256').update(invocationId).digest('hex'),
      createdAt: new Date().toISOString(),
      readOnly: false,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }
}
