import assert from 'node:assert/strict';
import test from 'node:test';
const module = await import('./ai-stage2-tool-results.ts').catch(() => ({}));
const result = { toolCallId: 'ok', toolName: 'application', data: { action: 'start', run: { id: 'run-1' } } };
const response = (status, body) => ({ status: () => status, json: async () => body });

test('collects durable details and separately records404 without claiming absence', async () => {
  assert.equal(typeof module.collectToolResults, 'function');
  const calls = [];
  const collected = await module.collectToolResults(['missing', 'ok', 'missing'], async (id) => {
    calls.push(id); return id === 'missing' ? response(404, { code: 'ENTRY_NOT_FOUND' }) : response(200, result);
  });
  assert.deepEqual(calls, ['missing', 'ok']);
  assert.deepEqual(collected, { results: [result], missingIds: ['missing'] });
});

for (const [name, read] of [
  ['forbidden', async () => response(403, {})], ['server error', async () => response(500, {})],
  ['network loss', async () => { throw new Error('network'); }],
  ['malformed success', async () => response(200, { toolCallId: 'ok', data: {} })],
  ['wrong call identity', async () => response(200, { ...result, toolCallId: 'another' })],
  ['unknown tool kind', async () => response(200, { ...result, toolName: 'unrecognized' })],
]) {
  test(`fails collection for ${name}`, async () => {
    assert.equal(typeof module.collectToolResults, 'function');
    await assert.rejects(module.collectToolResults(['ok'], read));
  });
}

test('requires independent durable IDs and rejects any missing-details intersection', () => {
  assert.equal(typeof module.verifyMissingToolResults, 'function');
  assert.doesNotThrow(() => module.verifyMissingToolResults(['missing'], ['ok']));
  assert.throws(() => module.verifyMissingToolResults(['missing'], ['ok', 'missing']));
  assert.throws(() => module.verifyMissingToolResults(['missing'], undefined));
});
