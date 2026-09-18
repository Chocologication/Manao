import { expect, test as base } from '@playwright/test';
import { DEFAULT_CLEANUP_POLICY } from './contracts.ts';
import { HttpCleanupTransport } from './http-transport.ts';
import { FileCleanupLedger } from './ledger.ts';
import { createTestResources, type Stage6Resources } from './runtime.ts';

export { expect };
export type { Stage6Resources } from './runtime.ts';

export const test = base.extend<{ resources: Stage6Resources }>({
  resources: [async ({}, use, testInfo) => {
    const invocationId = process.env.STAGE6_INVOCATION_ID ?? 'local-dev';
    const root = process.env.STAGE6_CLEANUP_LEDGER_DIR ?? 'test-results/stage6-cleanup/' + invocationId;
    const baseUrl = process.env.STAGE6_API_BASE_URL ?? 'http://127.0.0.1:4173';
    const ledger = new FileCleanupLedger(root, invocationId);
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
    const aliceUser = await transport.ownerId('alice').catch(() => process.env.STAGE6_ALICE_OWNER_ID ?? 'alice');
    const bobUser = await transport.ownerId('bob').catch(() => process.env.STAGE6_BOB_OWNER_ID ?? 'bob');
    const resources = await createTestResources({
      invocationId,
      testId: testInfo.titlePath.join('/'),
      attempt: testInfo.retry,
      workerKey: testInfo.workerIndex.toString(),
      ownerIds: { alice: aliceUser, bob: bobUser },
      ledger,
      transport,
      policy: DEFAULT_CLEANUP_POLICY,
    });
    try {
      await use(resources);
    } finally {
      const report = await resources.finish();
      await testInfo.attach('stage6-cleanup.json', {
        body: Buffer.from(JSON.stringify(report, null, 2)),
        contentType: 'application/json',
      });
      const incomplete = report.issues.length > 0
        || report.entries.some((entry) => entry.state === 'UNRESOLVED' || entry.state === 'HELD');
      if (incomplete && testInfo.status === testInfo.expectedStatus) {
        throw new Error('STAGE6_CLEANUP_INCOMPLETE');
      }
    }
  }, { auto: true, timeout: 660_000 }],
});
