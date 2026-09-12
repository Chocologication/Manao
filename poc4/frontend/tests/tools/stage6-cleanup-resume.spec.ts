import { expect, test } from '@playwright/test';
import { DEFAULT_CLEANUP_POLICY } from '../support/stage6-cleanup/contracts.ts';
import { HttpCleanupTransport } from '../support/stage6-cleanup/http-transport.ts';
import { FileCleanupLedger } from '../support/stage6-cleanup/ledger.ts';
import { applyResume, inspectResume } from '../support/stage6-cleanup/runtime.ts';

test('resume inspect is read-only and apply requires STAGE6_CLEANUP_APPLY=1', async () => {
  const root = process.env.STAGE6_CLEANUP_LEDGER_DIR;
  const invocationId = process.env.STAGE6_INVOCATION_ID;
  expect(root, 'STAGE6_CLEANUP_LEDGER_DIR is required').toBeTruthy();
  expect(invocationId, 'STAGE6_INVOCATION_ID is required').toBeTruthy();
  const ledger = new FileCleanupLedger(root as string, invocationId as string);
  const inspected = await inspectResume(ledger, invocationId as string);
  expect(inspected.invocationId).toBe(invocationId);
  if (process.env.STAGE6_CLEANUP_APPLY !== '1') {
    return;
  }
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
  await applyResume(
    ledger,
    invocationId as string,
    transport,
    { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    DEFAULT_CLEANUP_POLICY,
  );
});
