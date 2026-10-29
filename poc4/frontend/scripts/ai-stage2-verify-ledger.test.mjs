import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

// Dynamic import gives a behavioral RED for every case before implementation.
const module = await import('./ai-stage2-verify-ledger.mjs').catch(() => ({}));
const verify = (input) => {
  assert.equal(typeof module.verifyStage2Ledger, 'function', 'pure verifier must exist');
  return module.verifyStage2Ledger(input);
};
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = (n) => `2026-10-16 10:00:${String(n).padStart(2, '0')}.000001`;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const demo = 'src/main/java/com/example/app/DemoController.java';
const fixture = 'src/test/java/com/example/app/DemoControllerAcceptanceTest.java';

function evidence() {
  const projectId = id(1), taskId = id(2), r0 = id(3), r1 = id(4), r2 = id(5);
  const suite = { testClass: 'com.example.app.DemoControllerAcceptanceTest', tests: 1, failures: 0, errors: 0, skipped: 0, sha256: hash('report') };
  const run = (runId, revision, start, end) => ({ id: runId, projectId, requestedRevision: revision,
    state: end ? 'CANCELLED' : 'RUNNING', createdAt: stamp(start), firstReadyAt: stamp(start + 1),
    finishedAt: end ? stamp(end) : null, executionPodUid: `pod-${runId}`, activeRunMarker: end ? null : 1 });
  const runs = [run(r0, '10', 0, 4), run(r1, '10', 13, 26), run(r2, '11', 39, null)];
  const call = (n, toolName, args, data, start, end, revision = '10', extra = {}) => ({
    taskId, toolCallId: `call-${n}`, toolName, args, state: 'COMPLETED', expectedRevision: revision,
    createdAt: stamp(start), updatedAt: stamp(end), operationId: null,
    result: { toolCallId: `call-${n}`, workspaceRevision: revision, data, truncated: false }, ...extra,
  });
  const app = (action, runRow, activeRunId, stoppedConfirmed = false) => ({ kind: 'application', action,
    run: { id: runRow.id, state: stoppedConfirmed ? 'CANCELLED' : 'RUNNING', requestedWorkspaceRevision: runRow.requestedRevision,
      firstReadyAt: runRow.firstReadyAt, finishedAt: stoppedConfirmed ? runRow.finishedAt : null }, activeRunId, stoppedConfirmed, logs: null });
  const build = (revision) => ({ goal: 'test', sourceRevision: revision, exitCode: 0, cleanupConfirmed: true, testReports: [structuredClone(suite)] });
  const calls = [
    call(1, 'application', { action: 'stop', runId: r0 }, app('stop', runs[0], null, true), 3, 5),
    call(2, 'application', { action: 'status', runId: r0 }, app('status', runs[0], null, true), 6, 7),
    call(3, 'build', { goal: 'test' }, build('10'), 8, 10, '10', { operationId: id(10), jobName: 'build-1', jobUid: 'job-1', podUid: 'build-pod-1' }),
    call(4, 'application', { action: 'start' }, app('start', runs[1], r1), 12, 15, '10', { operationId: r1 }),
    call(5, 'app_http_get', { runId: r1, path: '/api/demo?name=Pi' }, { kind: 'app_http_get', runId: r1, path: '/api/demo?name=Pi', statusCode: 500, contentType: 'application/json', body: '{}', error: null, truncated: false }, 17, 18),
    call(6, 'application', { action: 'logs', runId: r1 }, { ...app('logs', runs[1], r1), logs: { text: 'stage2-seeded-handler-failure', firstSeq: 1, lastSeq: 1, truncated: false, complete: false } }, 19, 20),
    call(7, 'application', { action: 'stop', runId: r1 }, app('stop', runs[1], null, true), 25, 27),
    call(8, 'application', { action: 'status', runId: r1 }, app('status', runs[1], null, true), 28, 29),
    call(9, 'write_file', { path: demo, content: 'fixed source', expectedSha256: hash('old source') }, { path: demo, sha256: hash('fixed source') }, 30, 33, '10', { operationId: id(11) }),
    call(10, 'build', { goal: 'test' }, build('11'), 34, 36, '11', { operationId: id(12), jobName: 'build-2', jobUid: 'job-2', podUid: 'build-pod-2' }),
    call(11, 'application', { action: 'start' }, app('start', runs[2], r2), 38, 41, '11', { operationId: r2 }),
    call(12, 'app_http_get', { runId: r2, path: '/api/demo?name=Pi' }, { kind: 'app_http_get', runId: r2, path: '/api/demo?name=Pi', statusCode: 200, contentType: 'application/json', body: '{"message":"Hello Pi"}', error: null, truncated: false }, 42, 43, '11'),
  ];
  calls[8].result.workspaceRevision = '11';
  const operation = { id: id(11), projectId, operationKind: 'FILE', state: 'COMMITTED', expectedRevision: '10',
    beforeSha256: hash(`file\n${demo}\n${hash('old source')}`), afterSha256: hash(`file\n${demo}\n${hash('fixed source')}`),
    receiptSha256: hash('receipt'), receiptPath: `.manao/receipts/${id(11)}.json`, createdAt: stamp(31), committedAt: stamp(32) };
  const project = { id: projectId, runtime: { templateId: 'java-spring-boot-web', mysql: false, redis: false,
    publicPorts: [{ name: 'http', targetPort: 8080, publicPort: 30001 }] }, endpoints: [{ name: 'http', targetPort: 8080, publicPort: 30001, url: 'http://example.test:30001' }] };
  const service = { metadata: { name: `manao-app-${projectId}`, labels: { 'manao.poc4/project-id': projectId, 'app.kubernetes.io/managed-by': 'manao-poc4-backend' } },
    spec: { type: 'NodePort', clusterIP: '10.0.0.1', selector: { 'manao.poc4/project-id': projectId, 'manao.poc4/run-id': r2, 'manao.poc4/component': 'maven-run', 'manao.poc4/pod-uid': runs[2].executionPodUid }, ports: [{ name: 'http', protocol: 'TCP', port: 8080, targetPort: 8080, nodePort: 30001 }] } };
  return { taskId, projectId, seed: { r0Id: r0, revision: '10', fixtureSha256: hash('fixture') },
    task: { id: taskId, projectId, state: 'COMPLETED', failureCode: null, workspaceRevision: '10', settledRevision: '11', changedPaths: [demo], createdAt: stamp(2), updatedAt: stamp(44) },
    calls, runs, operations: [operation], logs: [{ runId: r1, projectId, seq: 1, text: 'stage2-seeded-handler-failure', createdAt: stamp(18) }],
    independent: { beforeAt: stamp(45), afterAt: stamp(46), activeBefore: structuredClone(runs[2]), activeAfter: structuredClone(runs[2]),
      serviceBefore: service, serviceAfter: structuredClone(service), project, fixtureSha256: hash('fixture'), workspaceRevision: '11',
      runId: r2, path: '/api/demo?name=Pi', url: 'http://example.test:30001/api/demo?name=Pi', statusCode: 200,
      contentType: 'application/json', body: '{"message":"Hello Pi"}', truncated: false } };
}

test('complete operator evidence passes, without claiming real model acceptance', () => {
  const result = verify(evidence());
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.equal(result.stagePassGranted, false);
  assert.deepEqual(result.toolCallIds, evidence().calls.map((call) => call.toolCallId));
});

function withUntrackedProjectRun(start, ready, finish) {
  const input = evidence();
  input.runs.push({ ...input.runs[1], id: id(93), requestedRevision: '11',
    createdAt: stamp(start), firstReadyAt: stamp(ready), finishedAt: stamp(finish) });
  return input;
}

test('rejects a terminal project Run overlapping the final active Run without mutation overlap', () => {
  assert.equal(verify(withUntrackedProjectRun(37, 38, 40)).verdict, 'FAIL');
});

test('rejects terminal project Runs with overlapping execution intervals', () => {
  assert.equal(verify(withUntrackedProjectRun(21, 22, 24)).verdict, 'FAIL');
});

test('rejects equal project Run finish and next creation timestamps as ambiguous', () => {
  assert.equal(verify(withUntrackedProjectRun(37, 38, 39)).verdict, 'FAIL');
});

test('accepts an additional project Run strictly between other Runs with no mutation overlap', () => {
  const input = evidence();
  input.runs.push({ ...input.runs[1], id: id(93), requestedRevision: '11',
    createdAt: '2026-10-16 10:00:36.000002', firstReadyAt: stamp(37), finishedAt: '2026-10-16 10:00:37.000002' });
  assert.equal(verify(input).verdict, 'PASS');
});

function withRejectedMissingRunStop() {
  const input = evidence();
  input.calls.unshift({ taskId: input.taskId, toolCallId: 'rejected-stop', toolName: 'application',
    args: { action: 'stop' }, state: 'COMPLETED', expectedRevision: '10', operationId: id(91),
    jobName: null, jobUid: null, podUid: null,
    createdAt: '2026-10-16 10:00:02.000002', updatedAt: '2026-10-16 10:00:02.000003',
    result: { toolCallId: 'rejected-stop', workspaceRevision: '10', truncated: false,
      data: { error: { code: 'VALIDATION_ERROR', message: 'Invalid application arguments' } } },
  });
  return input;
}

function withExtraGuestGet() {
  const input = evidence();
  const target = input.calls.at(-1);
  input.calls.push({ ...structuredClone(target), toolCallId: 'guest-get',
    args: { runId: target.args.runId, path: '/api/demo' },
    createdAt: '2026-10-16 10:00:43.000002', updatedAt: '2026-10-16 10:00:43.000003',
    result: { ...structuredClone(target.result), toolCallId: 'guest-get', data: {
      ...structuredClone(target.result.data), path: '/api/demo', body: '{"message":"Hello guest"}',
    } },
  });
  return input;
}

for (const status of [200, 404, 500]) {
  test(`an extra real HTTP${status} GET does not replace the required final Pi GET`, () => {
    const input = withExtraGuestGet();
    input.calls.at(-1).result.data.statusCode = status;
    assert.equal(verify(input).verdict, 'PASS');
  });
}

for (const [name, mutate] of Object.entries({
  'extra GET wrong result Run': (e) => { e.calls.at(-1).result.data.runId = e.seed.r0Id; },
  'extra GET unknown Run': (e) => { e.calls.at(-1).args.runId = id(99); e.calls.at(-1).result.data.runId = id(99); },
  'extra GET wrong returned path': (e) => { e.calls.at(-1).result.data.path = '/other'; },
  'extra GET absolute path': (e) => { e.calls.at(-1).args.path = 'http://attacker.invalid/'; e.calls.at(-1).result.data.path = e.calls.at(-1).args.path; },
  'extra GET before ready': (e) => { e.calls.at(-1).args.runId = e.seed.r0Id; e.calls.at(-1).result.data.runId = e.seed.r0Id; },
  'extra GET invalid HTTP status': (e) => { e.calls.at(-1).result.data.statusCode = 600; },
  'extra GET unknown status': (e) => { e.calls.at(-1).result.data.statusCode = null; },
  'extra GET transport error': (e) => { e.calls.at(-1).result.data.error = { code: 'AI_APP_HTTP_TIMEOUT' }; },
  'extra GET truncated': (e) => { e.calls.at(-1).result.data.truncated = true; },
  'extra GET exceeds body byte limit': (e) => { e.calls.at(-1).result.data.body = '界'.repeat(21846); },
  'missing required Pi success despite guest success': (e) => { e.calls.splice(-2, 1); },
})) {
  test(`rejects ${name}`, () => {
    const input = withExtraGuestGet();
    mutate(input);
    assert.equal(verify(input).verdict, 'FAIL');
  });
}

test('a settled missing-run stop rejection permits a later fully evidenced normal chain', () => {
  assert.equal(verify(withRejectedMissingRunStop()).verdict, 'PASS');
});

for (const [name, mutate] of Object.entries({
  'valid stop args disguised as validation rejection': (e) => { e.calls[0].args.runId = e.seed.r0Id; },
  'unknown rejection code': (e) => { e.calls[0].result.data.error.code = 'AI_CALL_UNKNOWN'; },
  'extra rejected argument': (e) => { e.calls[0].args.waitSeconds = 1; },
  'unsettled rejection': (e) => { e.calls[0].state = 'NEEDS_ATTENTION'; },
  'truncated rejection': (e) => { e.calls[0].result.truncated = true; },
  'rejection includes a Run result': (e) => { e.calls[0].result.data.run = { id: e.seed.r0Id }; },
  'rejection changed revision': (e) => { e.calls[0].result.workspaceRevision = '11'; },
  'rejection has a Job identity': (e) => { e.calls[0].jobUid = 'unexpected-job'; },
  'rejection operation became a Run': (e) => { e.runs.push({ ...e.runs[0], id: e.calls[0].operationId }); },
  'rejection operation became a receipt': (e) => { e.operations.push({ ...e.operations[0], id: e.calls[0].operationId }); },
  'rejection substitutes for real stop': (e) => { e.calls = e.calls.filter((call) => call.toolCallId !== 'call-1'); },
})) {
  test(`rejects ${name}`, () => {
    const input = withRejectedMissingRunStop();
    mutate(input);
    assert.equal(verify(input).verdict, 'FAIL');
  });
}

test('confirmed terminal stop permits the next mutation without redundant status calls', () => {
  const input = evidence();
  input.calls = input.calls.filter((call) => call.args.action !== 'status');
  assert.equal(verify(input).verdict, 'PASS');
});

test('unconfirmed stop can be followed by a fresh confirmed terminal status', () => {
  const input = evidence();
  for (const call of input.calls.filter((call) => call.args.action === 'stop')) {
    call.result.data.stoppedConfirmed = false;
    call.result.data.activeRunId = call.args.runId;
    call.result.data.run.state = 'STOPPING';
    call.result.data.run.finishedAt = null;
  }
  assert.equal(verify(input).verdict, 'PASS');
});

test('confirmed stop snapshot must agree with the authoritative terminal timestamp', () => {
  const input = evidence();
  input.calls = input.calls.filter((call) => call.args.action !== 'status');
  input.calls[0].result.data.run.finishedAt = stamp(1);
  assert.equal(verify(input).verdict, 'FAIL');
});

test('confirmed stop snapshot accepts the production ISO timestamp without losing microseconds', () => {
  const input = evidence();
  input.calls = input.calls.filter((call) => call.args.action !== 'status');
  for (const call of input.calls.filter((call) => call.args.action === 'stop')) {
    call.result.data.run.finishedAt = call.result.data.run.finishedAt.replace(' ', 'T') + 'Z';
  }
  assert.equal(verify(input).verdict, 'PASS');
});

test('confirmed stop cannot claim no active Run while another project Run covered its observation', () => {
  const input = evidence();
  input.calls = input.calls.filter((call) => call.args.action !== 'status');
  input.runs.push({ ...input.runs[0], id: id(90), createdAt: '2026-10-16 10:00:04.000002',
    firstReadyAt: '2026-10-16 10:00:04.000003', finishedAt: stamp(6) });
  assert.equal(verify(input).verdict, 'FAIL');
});

const adversaries = {
  'missing R0 exit': (e) => { e.runs[0].finishedAt = null; },
  'R0 not ready before task': (e) => { e.runs[0].firstReadyAt = e.task.createdAt; },
  'unconfirmed stop without fresh observation': (e) => {
    e.calls[0].result.data.stoppedConfirmed = false;
    e.calls[0].result.data.activeRunId = e.seed.r0Id;
    e.calls[0].result.data.run.state = 'STOPPING';
    e.calls[0].result.data.run.finishedAt = null;
    e.calls.splice(1, 1);
  },
  'first test failed': (e) => { e.calls[2].result.data.exitCode = 1; },
  'first test skipped': (e) => { e.calls[2].result.data.testReports[0].skipped = 1; },
  'zero tests': (e) => { e.calls[9].result.data.testReports[0].tests = 0; },
  'missing fixed suite': (e) => { e.calls[9].result.data.testReports[0].testClass = 'DifferentTest'; },
  'reports dropped': (e) => { e.calls[9].result.data.reportsDropped = true; },
  'missing real Job': (e) => { e.calls[9].jobUid = null; },
  'build outcome unknown': (e) => { e.calls[9].result.data.exitCode = null; },
  'build cleanup not proven': (e) => { e.calls[9].result.data.cleanupConfirmed = false; },
  'first HTTP is not 500': (e) => { e.calls[4].result.data.statusCode = 404; },
  'HTTP transport error': (e) => { e.calls[4].result.data.error = { code: 'AI_APP_HTTP_UNAVAILABLE' }; },
  'HTTP wrong Run': (e) => { e.calls[4].result.data.runId = e.seed.r0Id; },
  'HTTP before ready': (e) => { e.runs[1].firstReadyAt = e.calls[4].updatedAt; },
  'missing tool log marker': (e) => { e.calls[5].result.data.logs.text = ''; },
  'wrong log Run': (e) => { e.logs[0].runId = e.seed.r0Id; },
  'wrong log window': (e) => { e.calls[5].result.data.logs.firstSeq = 2; },
  'no durable log marker': (e) => { e.logs[0].text = ''; },
  'cross project Run': (e) => { e.runs[1].projectId = id(99); },
  'same R1/R2': (e) => { e.calls[10].operationId = e.calls[3].operationId; },
  'unstable start identity': (e) => { e.calls[3].operationId = id(99); },
  'missing final requested revision': (e) => { e.runs[2].requestedRevision = '10'; },
  'write before HTTP reproduction': (e) => { e.calls[8].createdAt = stamp(16); },
  'write overlaps run creation before readiness': (e) => { e.runs.push({ ...e.runs[1], id: id(80), createdAt: stamp(29), firstReadyAt: stamp(32), finishedAt: stamp(34) }); },
  'write overlaps stopping Run': (e) => { e.runs[1].finishedAt = stamp(31); },
  'build overlaps final active Run': (e) => { e.calls[9].updatedAt = stamp(40); },
  'write envelope overlaps old Run despite late receipt': (e) => { e.calls[8].createdAt = stamp(24); },
  'cross project receipt': (e) => { e.operations[0].projectId = id(99); },
  'uncommitted receipt': (e) => { e.operations[0].state = 'PENDING'; },
  'wrong receipt operation kind': (e) => { e.operations[0].operationKind = 'PYTHON_DEPENDENCIES'; },
  'wrong entry digest': (e) => { e.operations[0].afterSha256 = e.calls[8].result.data.sha256; },
  'wrong receipt revision': (e) => { e.operations[0].expectedRevision = '9'; },
  'receipt outside call envelope': (e) => { e.operations[0].committedAt = stamp(34); },
  'unknown extra mutation': (e) => { e.operations.push({ ...e.operations[0], id: id(88) }); },
  'fixture modified then restored': (e) => { e.calls[8].args.path = fixture; e.calls[8].result.data.path = fixture; },
  'unknown tool result': (e) => { e.calls[5].result = null; },
  'unfinished tool': (e) => { e.calls[5].state = 'NEEDS_ATTENTION'; },
  'same timestamps': (e) => { e.calls[8].createdAt = e.calls[7].updatedAt; },
  'lost microseconds': (e) => { e.calls[8].createdAt = '2026-10-16 10:00:30.000'; },
  'final tool HTTP body wrong': (e) => { e.calls[11].result.data.body = '{"message":"Hello guest"}'; },
  'final independent HTTP wrong': (e) => { e.independent.body = '{"message":"Hello guest"}'; },
  'independent body truncated': (e) => { e.independent.truncated = true; },
  'independent route switched': (e) => { e.independent.serviceAfter.spec.selector['manao.poc4/run-id'] = id(99); },
  'independent selector has extra entry': (e) => { e.independent.serviceBefore.spec.selector.extra = 'x'; },
  'independent Pod UID wrong': (e) => { e.independent.serviceBefore.spec.selector['manao.poc4/pod-uid'] = 'other'; },
  'independent target port wrong': (e) => { e.independent.serviceBefore.spec.ports[0].targetPort = 9999; },
  'independent ExternalName route': (e) => { e.independent.serviceBefore.spec.type = 'ExternalName'; },
  'independent headless route': (e) => { e.independent.serviceBefore.spec.clusterIP = 'None'; },
  'independent Service owner wrong': (e) => { e.independent.serviceBefore.metadata.labels['app.kubernetes.io/managed-by'] = 'other'; },
  'arbitrary public URL': (e) => { e.independent.url = 'http://attacker.test/api/demo?name=Pi'; },
  'public URL credentials': (e) => { e.independent.project.endpoints[0].url = 'http://user:pass@example.test:30001'; },
  'active changed across independent GET': (e) => { e.independent.activeAfter.id = id(99); },
  'final Run already stopped': (e) => { e.runs[2].finishedAt = stamp(44); e.runs[2].state = 'CANCELLED'; },
  'fixture bytes drift': (e) => { e.independent.fixtureSha256 = hash('changed'); },
  'task not complete': (e) => { e.task.state = 'FAILED'; },
  'task id noncanonical': (e) => { e.taskId = e.taskId.toUpperCase().replace('00000000', 'ABCDEF00'); },
  'missing all evidence': (e) => { delete e.calls; },
};
for (const [name, mutate] of Object.entries(adversaries)) {
  test(`rejects ${name}`, () => {
    const input = evidence();
    mutate(input);
    assert.equal(verify(input).verdict, 'FAIL');
  });
}

test('invalid input fails closed instead of throwing', () => {
  assert.equal(verify(null).verdict, 'FAIL');
});

test('Run evidence differences project only fixed identity and authority fields, including missing rows', () => {
  assert.equal(typeof module.runEvidenceDiff, 'function');
  const first = evidence().runs[0];
  const changed = { ...first, executionPodUid: 'changed-pod', password: 'secret-value', body: 'model-output' };
  const diff = module.runEvidenceDiff([first, { ...first, id: id(95), token: 'secret-value' }], [changed]);
  assert.equal(diff.strictSerializedChanged, true);
  assert.equal(diff.rows.length, 2);
  assert.equal(diff.rows[0].before.executionPodUid, first.executionPodUid);
  assert.equal(diff.rows[0].after.executionPodUid, 'changed-pod');
  assert.equal(diff.rows[1].after, null);
  assert.deepEqual(Object.keys(diff.rows[0].after), ['id', 'projectId', 'state', 'requestedRevision', 'createdAt', 'firstReadyAt', 'finishedAt', 'executionPodUid', 'activeRunMarker']);
  assert.doesNotMatch(JSON.stringify(diff), /secret-value|password|token|model-output|body/);
});

test('an independent active identity change stays FAIL and preserves its safe before/after evidence', () => {
  const input = evidence();
  input.independent.activeAfter.executionPodUid = 'changed-pod';
  const result = verify(input);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.failures, ['INDEPENDENT_ACTIVE_CHANGED']);
  assert.equal(result.evidenceDiff.rows[0].before.executionPodUid, input.runs[2].executionPodUid);
  assert.equal(result.evidenceDiff.rows[0].after.executionPodUid, 'changed-pod');
});

for (const missing of [null, undefined]) {
  test(`missing activeBefore ${missing} retains the pure FAIL contract with safe diagnostic`, () => {
    const input = evidence();
    input.independent.activeBefore = missing;
    const result = verify(input);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.failures, ['INDEPENDENT_ACTIVE_CHANGED']);
    assert.equal(result.evidenceDiff.rows[0].before, null);
    assert.equal(result.evidenceDiff.rows[0].after.id, input.runs[2].id);
  });
}

test('mysql batch preserves JSON escapes, tabs, newlines and CRLF row boundaries', () => {
  assert.equal(typeof module.parseMysqlJsonRows, 'function');
  const row = { text: 'line1\nline2\tC:\\source\\n.java', nil: null };
  const batchCell = JSON.stringify(row).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\t', '\\t');
  assert.deepEqual(module.parseMysqlJsonRows(`${batchCell}\r\n`), [row]);
});
