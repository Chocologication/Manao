import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAiOutputEnvironment, assembleOutputHistory } from '../tests/e2e/ai-output-contract.ts';

const valid = { MANAO_AI_ACCEPTANCE_BASE_URL: 'http://127.0.0.1:4200',
  MANAO_AI_ACCEPTANCE_PROJECT_ID: '00000000-0000-4000-8000-000000000006',
  MANAO_AI_ACCEPTANCE_USERNAME: 'fixture-owner', MANAO_AI_ACCEPTANCE_PASSWORD: 'private-test-only',
  MANAO_AI_OUTPUT_MODEL_AUTHORIZED: 'true' };

test('refuses each missing prerequisite and stale authorization without exposing values', () => {
  for (const field of Object.keys(valid)) {
    const env = { ...valid }; delete env[field];
    assert.throws(() => validateAiOutputEnvironment(env), error => {
      assert.match(error.message, /NOT_RUN/); assert.doesNotMatch(error.message, /private-test-only/); return true;
    });
  }
  assert.throws(() => validateAiOutputEnvironment({ ...valid, MANAO_AI_OUTPUT_MODEL_AUTHORIZED: 'TRUE' }), /NOT_RUN/);
});
test('accepts only an explicit origin and canonical project UUID', () => {
  assert.equal(validateAiOutputEnvironment(valid).projectId, valid.MANAO_AI_ACCEPTANCE_PROJECT_ID);
  for (const origin of ['file:///secret', 'https://user:private-test-only@example.test', 'http://127.0.0.1:4200/project', 'http://127.0.0.1:4200/?x=1']) {
    assert.throws(() => validateAiOutputEnvironment({ ...valid, MANAO_AI_ACCEPTANCE_BASE_URL: origin }), /NOT_RUN/);
  }
  assert.throws(() => validateAiOutputEnvironment({ ...valid, MANAO_AI_ACCEPTANCE_PROJECT_ID: '../other' }), /NOT_RUN/);
});
test('reassembles paginated native blocks by seq/contentIndex/offset without mixing thinking and answer', () => {
  const row = { seq: 6, taskId: 't', kind: 'assistant', contentIndex: 1, textOffset: 0, text: '# First', modelTruncated: false };
  assert.deepEqual(assembleOutputHistory([
    { ...row, textOffset: 7, text: ' answer', modelTruncated: true },
    { ...row, kind: 'thinking', contentIndex: 0, text: 'reason' }, row,
  ], 't'), [
    { seq: 6, contentIndex: 0, kind: 'thinking', text: 'reason', modelTruncated: false },
    { seq: 6, contentIndex: 1, kind: 'assistant', text: '# First answer', modelTruncated: true },
  ]);
});
