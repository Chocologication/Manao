import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceEnvironment, assertDisposableProject, assertPythonRound } from '../tests/e2e/ai-python-contract.ts';

const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
const environment = {
  MANAO_AI_ACCEPTANCE_BASE_URL: 'https://acceptance.example',
  MANAO_AI_ACCEPTANCE_USERNAME: 'private-owner', MANAO_AI_ACCEPTANCE_PASSWORD: 'private-password',
  MANAO_AI_PYTHON_CONSOLE_PROJECT_ID: ids[0], MANAO_AI_PYTHON_FASTAPI_PROJECT_ID: ids[1],
};
test('configuration rejects every missing name without exposing supplied credentials', () => {
  for (const name of Object.keys(environment)) {
    const input: Record<string, string | undefined> = { ...environment, [name]: undefined };
    assert.throws(() => acceptanceEnvironment(input), error => {
      assert.ok(error instanceof Error); assert.ok(error.message.includes(name));
      assert.ok(!error.message.includes('private-owner')); assert.ok(!error.message.includes('private-password')); return true;
    });
  }
  assert.throws(() => acceptanceEnvironment({}), /MANAO_AI_ACCEPTANCE_BASE_URL/);
});
test('configuration rejects reused identities and credential-bearing URLs', () => {
  assert.throws(() => acceptanceEnvironment({ ...environment, MANAO_AI_PYTHON_FASTAPI_PROJECT_ID: ids[0] }));
  assert.throws(() => acceptanceEnvironment({ ...environment, MANAO_AI_ACCEPTANCE_BASE_URL: 'https://user:secret@example.test' }), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('secret')); return true;
  });
  assert.equal(acceptanceEnvironment(environment).consoleProjectId, ids[0]);
});
test('a wrong, shared, occupied or non-template project fails before fixture writes', () => {
  const project = { id: ids[0], name: 'ai-python-acceptance-console-20261104', state: 'READY', runtime: { templateId: 'python-console' } };
  assertDisposableProject(project, ids[0]!, 'python-console', null, null, []);
  for (const change of [{ name: 'shared-project' }, { id: ids[1] }, { state: 'FAILED' }, { runtime: { templateId: 'java-console' } }]) {
    assert.throws(() => assertDisposableProject({ ...project, ...change }, ids[0]!, 'python-console', null, null, []));
  }
  assert.throws(() => assertDisposableProject(project, ids[0]!, 'python-console', {}, null, []));
  assert.throws(() => assertDisposableProject(project, ids[0]!, 'python-console', null, {}, []));
  assert.throws(() => assertDisposableProject(project, ids[0]!, 'python-console', null, null, [{}]));
});
let toolSequence = 0;
const result = (toolName: string, data: Record<string, unknown>) => ({ toolCallId: `tool-${++toolSequence}`, toolName, data });
const pytest = (state: string) => result('build', { language: 'python', checkKind: 'pytest', verificationStatus: state, exitCode: state === 'PASS' ? 0 : 1,
  cleanupConfirmed: true, sourceRevision: '9', testSummary: { tests: 1, failures: state === 'PASS' ? 0 : 1, errors: 0, skipped: 0, reportComplete: true } });
const evidence = () => [result('python_dependencies', { kind: 'python_dependencies', state: 'COMMITTED', operationId: ids[0], action: 'add', group: 'test', packageName: 'pytest', changedPaths: ['pyproject.toml', 'uv.lock'] }),
  pytest('FAILED'), result('python_dependencies', { kind: 'python_dependencies', state: 'COMMITTED', operationId: ids[1], action: 'add', group: 'main', packageName: 'rich', changedPaths: ['pyproject.toml', 'uv.lock'] }),
  result('build', { language: 'python', checkKind: 'syntax', verificationStatus: 'PASS', exitCode: 0, filesChecked: 2, cleanupConfirmed: true, sourceRevision: '9' }), pytest('PASS'),
  result('application', { kind: 'application', action: 'logs', run: { id: 'run1', state: 'SUCCEEDED', exitCode: 0, requestedWorkspaceRevision: '9' }, logs: { text: '6\n', complete: true, truncated: false } })];
test('round requires failed assertion then dependency pair, real syntax/test and exact run output', () => {
  assertPythonRound(evidence(), { kind: 'console', output: '6', first: true });
  assert.throws(() => assertPythonRound(evidence().filter(r => r.data.verificationStatus !== 'FAILED'), { kind: 'console', output: '6', first: true }));
  assert.throws(() => assertPythonRound(evidence().filter(r => r.data.group !== 'main'), { kind: 'console', output: '6', first: true }));
  const empty = evidence(); empty[4]!.data.testSummary = { tests: 0, failures: 0, errors: 0, skipped: 0, reportComplete: true };
  assert.throws(() => assertPythonRound(empty, { kind: 'console', output: '6', first: true }));
  const stale = evidence(); stale[5]!.data.run = { id: 'run1', state: 'SUCCEEDED', exitCode: 0, requestedWorkspaceRevision: '8' };
  assert.throws(() => assertPythonRound(stale, { kind: 'console', output: '6', first: true }));
  assert.throws(() => assertPythonRound(evidence(), { kind: 'console', output: '10', first: true }));
});
const fastapiEvidence = () => {
  const rows = evidence().slice(0, 5);
  rows.push(result('application', { kind: 'application', action: 'status',
    run: { id: 'web1', state: 'RUNNING', firstReadyAt: '2026-11-04T00:00:00Z', requestedWorkspaceRevision: '9',
      expiresAt: '2026-11-04T02:00:00Z', finishedAt: null, exitCode: null, terminationReason: null },
    activeRunId: 'web1', stoppedConfirmed: false, logs: null }));
  rows.push(result('app_http_get', { kind: 'app_http_get', runId: 'web1', path: '/api/demo', statusCode: 200, body: '{"message":"Hello from Manao","total":"1,000"}', truncated: false, error: null }));
  return rows;
};
const serviceLogs = () => result('application', { ...fastapiEvidence()[5]!.data, action: 'logs',
  logs: { text: 'INFO: Application startup complete.\n', firstSeq: 1, lastSeq: 1, truncated: false, complete: false } });
test('FastAPI needs readiness plus GET from the same run and exact business JSON', () => {
  const rows = [...fastapiEvidence(), serviceLogs()];
  assertPythonRound(rows, { kind: 'fastapi', output: '1,000', first: true });
  rows[6]!.data.runId = 'old-run'; assert.throws(() => assertPythonRound(rows, { kind: 'fastapi', output: '1,000', first: true }));
});
test('FastAPI requires a successful bounded native logs observation of the same ready Run and revision', () => {
  const expected = { kind: 'fastapi' as const, output: '1,000', first: true };
  assert.throws(() => assertPythonRound(fastapiEvidence(), expected), /logs/i);
  const valid = serviceLogs();
  assertPythonRound([...fastapiEvidence(), valid], expected); // live streams honestly retain complete=false
  for (const data of [
    { ...valid.data, run: { ...(valid.data.run as object), id: 'old-run' } },
    { ...valid.data, run: { ...(valid.data.run as object), requestedWorkspaceRevision: '8' } },
    { ...valid.data, error: { code: 'AI_APPLICATION_UNAVAILABLE', message: 'Application unavailable' } },
    { ...valid.data, action: 'status' },
    { ...valid.data, logs: null },
    { ...valid.data, logs: { ...(valid.data.logs as object), text: '' } },
    { ...valid.data, logs: { ...(valid.data.logs as object), text: 'x'.repeat(64 * 1024 + 1) } },
    { ...valid.data, logs: { ...(valid.data.logs as object), text: '[manao] log source lost' } },
    { ...valid.data, logs: { ...(valid.data.logs as object), firstSeq: null } },
    { ...valid.data, logs: { ...(valid.data.logs as object), lastSeq: 0 } },
    { ...valid.data, logs: { ...(valid.data.logs as object), truncated: 'false' } },
    { ...valid.data, logs: { ...(valid.data.logs as object), complete: undefined } },
    { ...valid.data, logs: { ...(valid.data.logs as object), complete: true } },
  ]) assert.throws(() => assertPythonRound([...fastapiEvidence(), result('application', data)], expected), /logs/i);
  assertPythonRound([...fastapiEvidence(), result('application', { ...valid.data,
    logs: { ...(valid.data.logs as object), text: 'Bounded tail of a longer log stream.\n', firstSeq: 2, lastSeq: 3, truncated: true } })], expected);
  const otherReady = result('application', { ...fastapiEvidence()[5]!.data,
    run: { ...(valid.data.run as object), id: 'web2' } });
  const otherLogs = result('application', { ...valid.data, run: otherReady.data.run });
  assert.throws(() => assertPythonRound([...fastapiEvidence(), otherReady, otherLogs], expected), /same ready Run/);
});
