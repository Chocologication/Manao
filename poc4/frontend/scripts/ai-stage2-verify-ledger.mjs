import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const REVISION = /^(0|[1-9][0-9]*)$/;
const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
const ACTIVE = new Set(['STARTING', 'RUNNING', 'STOPPING', 'RECOVERING']);
const TOOLS = new Set(['list_files', 'read_file', 'write_file', 'build', 'application', 'app_http_get']);
const DEMO = 'src/main/java/com/example/app/DemoController.java';
const FIXTURE = 'src/test/java/com/example/app/DemoControllerAcceptanceTest.java';
const SUITE = 'com.example.app.DemoControllerAcceptanceTest';
const HTTP_PATH = '/api/demo?name=Pi';
const MARKER = 'stage2-seeded-handler-failure';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const requireEvidence = (condition, code) => { if (!condition) throw new Error(code); };
const time = (value) => { requireEvidence(typeof value === 'string' && TIME.test(value), 'TIMESTAMP_PRECISION'); return value; };
const nonempty = (value) => typeof value === 'string' && value.length > 0;
const dataOf = (call) => call.result.data;
const before = (a, b) => time(a) < time(b);

const RUN_EVIDENCE_FIELDS = ['id', 'projectId', 'state', 'requestedRevision', 'createdAt', 'firstReadyAt', 'finishedAt', 'executionPodUid', 'activeRunMarker'];
function safeRunEvidence(run) {
  if (run === null || run === undefined) return null;
  return Object.fromEntries(RUN_EVIDENCE_FIELDS.map((field) => {
    const value = run[field];
    return [field, value === null || typeof value === 'string' || typeof value === 'number' ? value : '[invalid]'];
  }));
}

export function runEvidenceDiff(beforeRows, afterRows) {
  const beforeById = new Map(beforeRows.filter((run) => run != null).map((run) => [run.id, run]));
  const afterById = new Map(afterRows.filter((run) => run != null).map((run) => [run.id, run]));
  return {
    strictSerializedChanged: JSON.stringify([...beforeRows].sort((a,b) => String(a?.id ?? '').localeCompare(String(b?.id ?? ''))))
      !== JSON.stringify([...afterRows].sort((a,b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')))),
    rows: [...new Set([...beforeById.keys(), ...afterById.keys()])].sort().map((id) => ({
      before: safeRunEvidence(beforeById.get(id)), after: safeRunEvidence(afterById.get(id)),
    })).filter((row) => JSON.stringify(row.before) !== JSON.stringify(row.after)),
  };
}

// This exact rejection occurs after ledger identity reservation but before any
// application claim or Run control. A reserved operationId alone is not execution.
function rejectedMissingRunStop(call, runs, operations) {
  const data = call.result?.data, error = data?.error;
  return call.toolName === 'application' && call.args?.action === 'stop'
    && Object.keys(call.args).length === 1
    && data && Object.keys(data).length === 1 && error
    && Object.keys(error).length === 2 && error.code === 'VALIDATION_ERROR'
    && error.message === 'Invalid application arguments' && call.result.truncated === false
    && UUID.test(call.operationId) && call.jobName === null && call.jobUid === null && call.podUid === null
    && !runs.some((run) => run.id === call.operationId)
    && !operations.some((operation) => operation.id === call.operationId);
}

function successTest(call) {
  const data = dataOf(call);
  const report = data.testReports?.filter((entry) => entry.testClass === SUITE);
  return call.toolName === 'build' && call.args.goal === 'test' && data.goal === 'test'
    && data.exitCode === 0 && data.cleanupConfirmed === true && data.reportsDropped !== true
    && nonempty(call.jobName) && nonempty(call.jobUid) && nonempty(call.podUid)
    && report?.length === 1 && Number.isInteger(report[0].tests) && report[0].tests >= 1
    && report[0].failures === 0 && report[0].errors === 0 && report[0].skipped === 0
    && SHA.test(report[0].sha256);
}

function ownerEndpoint(project, projectId) {
  requireEvidence(project?.id === projectId && project.runtime?.templateId === 'java-spring-boot-web'
    && project.runtime.mysql === false && project.runtime.redis === false, 'OWNER_PROJECT');
  const primary = project.runtime.publicPorts?.[0];
  requireEvidence(primary && Number.isInteger(primary.publicPort) && primary.publicPort >= 30000
    && primary.publicPort <= 31000 && Number.isInteger(primary.targetPort) && nonempty(primary.name), 'PRIMARY_PORT');
  const endpoints = project.endpoints?.filter((entry) => entry.name === primary.name);
  requireEvidence(endpoints?.length === 1 && endpoints[0].publicPort === primary.publicPort
    && endpoints[0].targetPort === primary.targetPort, 'OWNER_ENDPOINT');
  const url = new URL(endpoints[0].url);
  requireEvidence(url.protocol === 'http:' && !url.username && !url.password && url.pathname === '/'
    && !url.search && !url.hash && Number(url.port) === primary.publicPort, 'OWNER_ENDPOINT_URL');
  return { primary, url: new URL(HTTP_PATH, url).href };
}

function verifyService(service, projectId, run, primary) {
  const labels = service?.metadata?.labels;
  const spec = service?.spec;
  const expected = { 'manao.poc4/project-id': projectId, 'manao.poc4/run-id': run.id,
    'manao.poc4/component': 'maven-run', 'manao.poc4/pod-uid': run.executionPodUid };
  requireEvidence(service?.metadata?.name === `manao-app-${projectId}`
    && labels?.['manao.poc4/project-id'] === projectId
    && labels?.['app.kubernetes.io/managed-by'] === 'manao-poc4-backend'
    && spec?.type === 'NodePort' && nonempty(spec.clusterIP) && spec.clusterIP !== 'None'
    && Object.keys(spec.selector ?? {}).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => spec.selector[key] === value), 'SERVICE_IDENTITY');
  const ports = spec.ports?.filter((port) => port.name === primary.name);
  requireEvidence(ports?.length === 1 && ports[0].protocol === 'TCP'
    && ports[0].port === primary.targetPort && ports[0].targetPort === primary.targetPort
    && ports[0].nodePort === primary.publicPort, 'SERVICE_PORT');
}

function verifyHttpObservation(call, run) {
  const data = dataOf(call);
  const path = call.args.path;
  requireEvidence(typeof path === 'string' && path.length <= 2048 && path.startsWith('/') && !path.startsWith('//')
    && !/[\\#\u0000-\u0020\u007f]/.test(path), 'HTTP_PATH');
  const url = new URL(path, 'http://project.invalid');
  requireEvidence(url.origin === 'http://project.invalid' && run && call.args.runId === run.id
    && data.kind === 'app_http_get' && data.runId === run.id && data.path === path
    && Number.isInteger(data.statusCode) && data.statusCode >= 100 && data.statusCode <= 599
    && data.error === null && data.truncated === false
    && call.result.truncated === false && typeof data.body === 'string'
    && Buffer.byteLength(data.body, 'utf8') <= 65536
    && before(run.createdAt, run.firstReadyAt) && before(run.firstReadyAt, call.createdAt)
    && (run.finishedAt === null || before(call.updatedAt, run.finishedAt)), 'HTTP_RUN_RESULT');
}

function verifyHttp(call, run, expectedStatus) {
  verifyHttpObservation(call, run);
  const data = dataOf(call);
  requireEvidence(call.args.path === HTTP_PATH && data.statusCode === expectedStatus, 'HTTP_RUN_RESULT');
  if (expectedStatus === 200) {
    requireEvidence(data.contentType?.toLowerCase().includes('application/json')
      && JSON.parse(data.body).message === 'Hello Pi', 'HTTP_JSON_CONTRACT');
  }
}

/** Pure evidence verdict. Even PASS never independently grants a model/cluster/browser stage PASS. */
export function verifyStage2Ledger(input) {
  try {
    const { taskId, projectId, seed, task, calls: sourceCalls, runs, operations, logs, independent } = input;
    requireEvidence(UUID.test(taskId) && UUID.test(projectId) && UUID.test(seed.r0Id)
      && REVISION.test(seed.revision) && SHA.test(seed.fixtureSha256), 'CANONICAL_IDENTITY');
    requireEvidence(task.id === taskId && task.projectId === projectId && task.state === 'COMPLETED'
      && task.failureCode === null && task.workspaceRevision === seed.revision, 'TASK_NOT_COMPLETED');
    requireEvidence(Array.isArray(sourceCalls) && sourceCalls.length > 0 && Array.isArray(runs)
      && Array.isArray(operations) && Array.isArray(logs), 'EVIDENCE_MISSING');
    const calls = [...sourceCalls].sort((a, b) => time(a.createdAt).localeCompare(time(b.createdAt)));
    requireEvidence(new Set(calls.map((call) => call.toolCallId)).size === calls.length, 'DUPLICATE_CALL');
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      requireEvidence(call.taskId === taskId && call.state === 'COMPLETED' && TOOLS.has(call.toolName)
        && call.args && call.result?.data && call.result.toolCallId === call.toolCallId
        && (call.result.data.error == null || rejectedMissingRunStop(call, runs, operations))
        && REVISION.test(call.expectedRevision), 'UNKNOWN_TOOL_RESULT');
      requireEvidence(before(task.createdAt, call.createdAt) && before(call.createdAt, call.updatedAt)
        && before(call.updatedAt, task.updatedAt)
        && (index === 0 || before(calls[index - 1].updatedAt, call.createdAt)), 'AMBIGUOUS_TOOL_ORDER');
      if (call.toolName === 'build') requireEvidence(Number.isInteger(dataOf(call).exitCode)
        && dataOf(call).cleanupConfirmed === true && nonempty(call.jobName) && nonempty(call.jobUid)
        && nonempty(call.podUid), 'BUILD_UNKNOWN');
    }
    requireEvidence(new Set(runs.map((run) => run.id)).size === runs.length, 'DUPLICATE_RUN');
    for (const run of runs) {
      requireEvidence(run.projectId === projectId && UUID.test(run.id) && REVISION.test(run.requestedRevision)
        && (TERMINAL.has(run.state) || ACTIVE.has(run.state)), 'RUN_IDENTITY');
      time(run.createdAt);
      if (TERMINAL.has(run.state)) requireEvidence(before(run.createdAt, run.finishedAt)
        && run.activeRunMarker === null, 'RUN_EXIT_MISSING');
      else requireEvidence(run.finishedAt === null && run.activeRunMarker === 1, 'RUN_AUTHORITY_UNKNOWN');
    }
    const orderedRuns = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let index = 1; index < orderedRuns.length; index++) {
      const previous = orderedRuns[index - 1], current = orderedRuns[index];
      requireEvidence(previous.finishedAt !== null && before(previous.finishedAt, current.createdAt), 'PROJECT_RUN_OVERLAP');
    }
    const r0 = runs.find((run) => run.id === seed.r0Id);
    requireEvidence(r0 && r0.requestedRevision === seed.revision && before(r0.createdAt, r0.firstReadyAt)
      && before(r0.firstReadyAt, task.createdAt) && before(task.createdAt, r0.finishedAt), 'R0_READY_EXIT');

    // Runs start when the DB row is inserted, including STARTING and STOPPING time.
    // The claim window between start registration and insertion is protected as well.
    const starts = calls.filter((call) => call.toolName === 'application' && call.args.action === 'start');
    requireEvidence(starts.length >= 2 && starts.length <= 4, 'START_COUNT');
    for (const call of starts) {
      const run = runs.find((entry) => entry.id === call.operationId);
      requireEvidence(run && UUID.test(call.operationId) && dataOf(call).kind === 'application'
        && dataOf(call).action === 'start' && dataOf(call).run?.id === run.id
        && dataOf(call).run.requestedWorkspaceRevision === call.expectedRevision
        && run.requestedRevision === call.expectedRevision && before(call.createdAt, run.createdAt)
        && before(run.createdAt, call.updatedAt), 'STABLE_START_IDENTITY');
    }
    const mutations = calls.filter((call) => ['write_file', 'build'].includes(call.toolName));
    for (const call of mutations) {
      for (const run of runs) requireEvidence(before(call.updatedAt, run.createdAt)
        || (run.finishedAt !== null && before(run.finishedAt, call.createdAt)), 'ACTIVE_RUN_OVERLAP');
      for (const start of starts) requireEvidence(before(call.updatedAt, start.createdAt)
        || before(start.updatedAt, call.createdAt), 'START_CLAIM_OVERLAP');
    }
    let revision = seed.revision;
    const writes = calls.filter((call) => call.toolName === 'write_file');
    const operationIds = new Set();
    for (const call of calls) {
      requireEvidence(call.expectedRevision === revision, 'CALL_REVISION');
      const data = dataOf(call);
      if (call.toolName === 'write_file') {
        requireEvidence(call.args.path !== FIXTURE && data.path === call.args.path
          && typeof call.args.content === 'string' && SHA.test(data.sha256)
          && data.sha256 === sha(call.args.content), 'FIXTURE_OR_WRITE_DRIFT');
        const matches = operations.filter((operation) => operation.id === call.operationId);
        requireEvidence(matches.length === 1 && !operationIds.has(call.operationId), 'FILE_RECEIPT_IDENTITY');
        operationIds.add(call.operationId);
        const operation = matches[0];
        const expectedBefore = call.args.expectedSha256 == null ? sha(`absent\n${data.path}`)
          : sha(`file\n${data.path}\n${call.args.expectedSha256}`);
        requireEvidence(operation.projectId === projectId && operation.state === 'COMMITTED'
          && operation.operationKind === 'FILE' && operation.expectedRevision === revision
          && operation.beforeSha256 === expectedBefore
          && operation.afterSha256 === sha(`file\n${data.path}\n${data.sha256}`)
          && SHA.test(operation.receiptSha256) && nonempty(operation.receiptPath)
          && before(call.createdAt, operation.createdAt) && before(operation.createdAt, operation.committedAt)
          && before(operation.committedAt, call.updatedAt), 'FILE_RECEIPT_INVALID');
        revision = String(BigInt(revision) + 1n);
      }
      requireEvidence(call.result.workspaceRevision === revision, 'RESULT_REVISION');
      if (call.toolName === 'build') requireEvidence(data.sourceRevision === revision
        && data.goal === call.args.goal, 'BUILD_REVISION');
    }
    requireEvidence(operations.every((operation) => operationIds.has(operation.id)), 'UNKNOWN_MUTATION');
    requireEvidence(task.settledRevision === revision && Array.isArray(task.changedPaths)
      && writes.some((call) => call.args.path === DEMO)
      && writes.every((call) => task.changedPaths.includes(call.args.path)), 'TASK_SETTLED_REVISION');

    const httpCalls = calls.filter((call) => call.toolName === 'app_http_get');
    for (const call of httpCalls) verifyHttpObservation(call, runs.find((run) => run.id === call.args.runId));
    const targetHttpCalls = httpCalls.filter((call) => call.args.path === HTTP_PATH);
    requireEvidence(targetHttpCalls.length >= 2, 'HTTP_CHAIN_MISSING');
    const firstHttp = targetHttpCalls[0], lastHttp = targetHttpCalls.at(-1);
    const r1 = runs.find((run) => run.id === dataOf(firstHttp).runId);
    const r2 = runs.find((run) => run.id === dataOf(lastHttp).runId);
    requireEvidence(r1 && r2 && new Set([r0.id, r1.id, r2.id]).size === 3
      && starts.some((call) => call.operationId === r1.id) && starts.at(-1).operationId === r2.id, 'R1_R2_IDENTITY');
    verifyHttp(firstHttp, r1, 500);
    verifyHttp(lastHttp, r2, 200);
    requireEvidence(r1.requestedRevision === seed.revision && r2.requestedRevision === revision
      && r2.state === 'RUNNING' && r2.finishedAt === null, 'R2_ACTIVE_REVISION');
    requireEvidence(writes.every((call) => before(firstHttp.updatedAt, call.createdAt)), 'PRE_REPRODUCTION_WRITE');
    const builds = calls.filter((call) => call.toolName === 'build');
    requireEvidence(successTest(builds[0]) && builds[0].expectedRevision === seed.revision
      && before(builds[0].updatedAt, starts.find((call) => call.operationId === r1.id).createdAt), 'FIRST_TEST_NOT_REAL');
    const lastWrite = writes.at(-1);
    requireEvidence(builds.some((call) => successTest(call) && before(lastWrite.updatedAt, call.createdAt)
      && before(call.updatedAt, starts.at(-1).createdAt) && dataOf(call).sourceRevision === revision), 'FINAL_TEST_NOT_REAL');
    for (const [run, nextMutation] of [[r0, builds[0]], [r1, writes[0]]]) {
      const stop = calls.find((call) => call.toolName === 'application' && call.args.action === 'stop'
        && call.args.runId === run.id && before(call.createdAt, run.finishedAt));
      const confirmed = (call) => {
        const data = dataOf(call), snapshot = data.run;
        // Run JSON uses ISO instants; normalize text without JS Date precision loss.
        const finish = typeof snapshot?.finishedAt === 'string'
          ? snapshot.finishedAt.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/,
            (_, day, clock, fraction = '') => `${day} ${clock}.${fraction.padEnd(6, '0')}`)
          : null;
        return data.kind === 'application' && data.action === call.args.action
          && snapshot?.id === run.id && snapshot.state === run.state
          && snapshot.requestedWorkspaceRevision === run.requestedRevision
          && finish === run.finishedAt && data.stoppedConfirmed === true && data.activeRunId === null
          && before(run.finishedAt, call.updatedAt) && before(call.updatedAt, nextMutation.createdAt)
          && runs.every((candidate) => before(call.updatedAt, candidate.createdAt)
            || (candidate.finishedAt !== null && before(candidate.finishedAt, call.updatedAt)));
      };
      requireEvidence(stop && (confirmed(stop) || calls.some((call) => call.toolName === 'application'
        && call.args.action === 'status' && call.args.runId === run.id
        && before(stop.updatedAt, call.createdAt) && before(run.finishedAt, call.createdAt)
        && confirmed(call))), 'FRESH_STOP_OBSERVATION');
    }
    const logCalls = calls.filter((call) => call.toolName === 'application' && call.args.action === 'logs'
      && call.args.runId === r1.id && before(firstHttp.updatedAt, call.createdAt)
      && before(call.updatedAt, writes[0].createdAt));
    requireEvidence(logCalls.some((call) => {
      const data = dataOf(call), tail = data.logs;
      if (data.kind !== 'application' || data.action !== 'logs' || data.run?.id !== r1.id
        || !tail?.text?.includes(MARKER) || !Number.isInteger(tail.firstSeq)
        || !Number.isInteger(tail.lastSeq) || tail.firstSeq > tail.lastSeq) return false;
      const window = logs.filter((entry) => entry.runId === r1.id && entry.projectId === projectId
        && entry.seq >= tail.firstSeq && entry.seq <= tail.lastSeq && time(entry.createdAt) <= call.updatedAt)
        .sort((a, b) => a.seq - b.seq);
      return window.length === tail.lastSeq - tail.firstSeq + 1
        && window.every((entry, index) => entry.seq === tail.firstSeq + index)
        && window.map((entry) => entry.text).join('').includes(tail.text);
    }), 'R1_DURABLE_LOG_MARKER');

    const { primary, url } = ownerEndpoint(independent.project, projectId);
    requireEvidence(independent.runId === r2.id && independent.path === HTTP_PATH && independent.url === url
      && independent.fixtureSha256 === seed.fixtureSha256 && independent.workspaceRevision === revision
      && independent.statusCode === 200 && independent.truncated === false
      && independent.contentType?.toLowerCase().includes('application/json')
      && JSON.parse(independent.body).message === 'Hello Pi'
      && before(task.updatedAt, independent.beforeAt) && before(independent.beforeAt, independent.afterAt), 'INDEPENDENT_HTTP');
    for (const active of [independent.activeBefore, independent.activeAfter]) requireEvidence(active?.id === r2.id
      && active.projectId === projectId && active.state === 'RUNNING' && active.finishedAt === null
      && active.requestedRevision === revision && active.executionPodUid === r2.executionPodUid
      && active.firstReadyAt === r2.firstReadyAt && active.activeRunMarker === 1, 'INDEPENDENT_ACTIVE_CHANGED');
    requireEvidence(runs.filter((run) => ACTIVE.has(run.state)).length === 1, 'UNEXPECTED_ACTIVE_RUN');
    verifyService(independent.serviceBefore, projectId, r2, primary);
    verifyService(independent.serviceAfter, projectId, r2, primary);
    return { verdict: 'PASS', stagePassGranted: false, taskId, projectId, r0: r0.id, r1: r1.id, r2: r2.id,
      calls: calls.length, toolCallIds: calls.map((call) => call.toolCallId), writes: writes.length, builds: builds.length, revision,
      note: 'Operator evidence only; real model, browser, rollout and lifecycle records remain separate gates.' };
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'EVIDENCE_INVALID';
    const evidenceDiff = code === 'INDEPENDENT_ACTIVE_CHANGED'
      ? { ...runEvidenceDiff([input.independent.activeBefore], [input.independent.activeAfter]),
        expected: safeRunEvidence(input.runs.find((run) => run.id === input.independent.runId)) } : undefined;
    return { verdict: 'FAIL', stagePassGranted: false, failures: [code], ...(evidenceDiff ? { evidenceDiff } : {}) };
  }
}

// Same small mysql --batch transport as Stage 1, with env-only passwords and
// sanitized failures. Split rows BEFORE reversing per-cell escaping.
export function parseMysqlJsonRows(raw) {
  return raw.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
    .filter(Boolean).map((line) => {
      requireEvidence(!line.includes('\t'), 'MYSQL_ROW_SHAPE');
      const cell = line.replace(/\\\\/g, '\u0000').replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t').replace(/\\0/g, '\0').split('\u0000').join('\\');
      return JSON.parse(cell);
    });
}

function execute(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', size = 0, exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, 30_000);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { exceeded = true; child.kill(); }
      else output += chunk;
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('OPERATOR_TRANSPORT_FAILED')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !exceeded) resolve(output);
      else reject(new Error('OPERATOR_TRANSPORT_FAILED'));
    });
  });
}

async function publicGet(url) {
  // Native fetch: one explicit GET, no credentials, no redirect, shared 10s
  // header/body deadline. No Authorization/Cookie from owner API is forwarded.
  const response = await fetch(url, { method: 'GET', redirect: 'manual',
    headers: { Accept: 'application/json,text/plain,*/*' }, signal: AbortSignal.timeout(10_000) });
  const reader = response.body?.getReader();
  const chunks = [];
  let bytes = 0, truncated = false;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = 65536 - bytes;
        chunks.push(value.subarray(0, remaining));
        bytes += Math.min(remaining, value.length);
        if (value.length > remaining) { truncated = true; break; }
      }
    } finally { await reader.cancel(); }
  }
  return { statusCode: response.status, contentType: response.headers.get('content-type'),
    body: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function main() {
  const env = process.env;
  requireEvidence(process.argv.length === 4 && process.argv[2] === '--task-id', 'USAGE_TASK_ID');
  const taskId = process.argv[3], projectId = env.MANAO_AI_ACCEPTANCE_PROJECT_ID;
  requireEvidence(UUID.test(taskId) && UUID.test(projectId), 'CANONICAL_IDENTITY');
  const required = ['MANAO_AI_ACCEPTANCE_R0_ID', 'MANAO_AI_ACCEPTANCE_INITIAL_REVISION',
    'MANAO_AI_ACCEPTANCE_BASE_URL', 'MANAO_AI_ACCEPTANCE_USERNAME', 'MANAO_AI_ACCEPTANCE_PASSWORD',
    'MANAO_AI_VERIFY_DB_NAME', 'MANAO_AI_VERIFY_DB_USER', 'MANAO_AI_VERIFY_DB_PASSWORD',
    'MANAO_AI_VERIFY_KUBE_CONTEXT', 'MANAO_AI_VERIFY_KUBE_NAMESPACE'];
  requireEvidence(required.every((name) => nonempty(env[name])), 'OPERATOR_CONFIG_MISSING');
  requireEvidence(UUID.test(env.MANAO_AI_ACCEPTANCE_R0_ID)
    && REVISION.test(env.MANAO_AI_ACCEPTANCE_INITIAL_REVISION), 'SEED_IDENTITY');
  requireEvidence((env.MANAO_AI_VERIFY_MYSQL_PASSWORD_MODE ?? 'env') === 'env', 'PASSWORD_ENV_ONLY');
  const prefix = (env.MANAO_AI_VERIFY_MYSQL_CMD ?? 'mysql').split(' ').filter(Boolean);
  requireEvidence(prefix.length > 0 && !prefix.some((arg) => arg.startsWith('-p')
    || arg.startsWith('--password') || arg.startsWith('MYSQL_PWD=')), 'PASSWORD_ENV_ONLY');
  const dbPort = env.MANAO_AI_VERIFY_DB_PORT ?? '3306';
  requireEvidence(/^\d+$/.test(dbPort) && Number(dbPort) >= 1 && Number(dbPort) <= 65535
    && /^[A-Za-z0-9_]+$/.test(env.MANAO_AI_VERIFY_DB_NAME), 'DATABASE_CONFIG');
  const query = async (sql) => parseMysqlJsonRows(await execute(prefix[0], [...prefix.slice(1),
    '-h', env.MANAO_AI_VERIFY_DB_HOST ?? '127.0.0.1', '-P', dbPort,
    '-u', env.MANAO_AI_VERIFY_DB_USER, '-D', env.MANAO_AI_VERIFY_DB_NAME, '--batch', '-N', '-e', sql],
  { ...env, MYSQL_PWD: env.MANAO_AI_VERIFY_DB_PASSWORD }));
  const dt = (column) => `DATE_FORMAT(${column},'%Y-%m-%d %H:%i:%s.%f')`;
  const taskScope = `id='${taskId}' AND project_id='${projectId}'`;
  const taskRows = await query(`SELECT JSON_OBJECT('id',id,'projectId',project_id,'state',state,
    'failureCode',failure_code,'workspaceRevision',CAST(workspace_revision AS CHAR),
    'settledRevision',CAST(settled_revision AS CHAR),'changedPaths',changed_paths_json,
    'createdAt',${dt('created_at')},'updatedAt',${dt('updated_at')}) FROM agent_task WHERE ${taskScope}`);
  requireEvidence(taskRows.length === 1 && taskRows[0].state === 'COMPLETED', 'TASK_NOT_COMPLETED');
  const calls = await query(`SELECT JSON_OBJECT('taskId',c.task_id,'toolCallId',c.tool_call_id,'toolName',c.tool_name,
    'args',c.args_json,'state',c.state,'operationId',c.workspace_operation_id,
    'expectedRevision',CAST(c.expected_revision AS CHAR),'result',c.result_json,
    'jobName',c.job_name,'jobUid',c.job_uid,'podUid',c.pod_uid,
    'createdAt',${dt('c.created_at')},'updatedAt',${dt('c.updated_at')})
    FROM agent_tool_call c JOIN agent_task t ON t.id=c.task_id
    WHERE t.id='${taskId}' AND t.project_id='${projectId}'`);
  const runSelect = `SELECT JSON_OBJECT('id',r.id,'projectId',r.project_id,
    'requestedRevision',CAST(r.requested_revision AS CHAR),'state',r.state,
    'createdAt',${dt('r.created_at')},'firstReadyAt',${dt('r.first_ready_at')},
    'finishedAt',${dt('r.finished_at')},'executionPodUid',r.execution_pod_uid,
    'activeRunMarker',r.active_run_marker) FROM run r
    WHERE r.project_id='${projectId}' AND EXISTS(SELECT 1 FROM agent_task t WHERE t.id='${taskId}' AND t.project_id=r.project_id)`;
  const runs = await query(runSelect);
  const operations = await query(`SELECT JSON_OBJECT('id',w.id,'projectId',w.project_id,
    'expectedRevision',CAST(w.expected_revision AS CHAR),'state',w.state,'operationKind',w.operation_kind,
    'beforeSha256',w.before_sha256,'afterSha256',w.after_sha256,'receiptPath',w.receipt_path,
    'receiptSha256',w.receipt_sha256,'createdAt',${dt('w.created_at')},'committedAt',${dt('w.committed_at')})
    FROM workspace_operation w JOIN agent_task t ON t.project_id=w.project_id
    WHERE t.id='${taskId}' AND t.project_id='${projectId}' AND w.created_at>=t.created_at`);
  const logs = await query(`SELECT JSON_OBJECT('runId',l.run_id,'projectId',r.project_id,'seq',l.seq,
    'text',l.text_utf8,'createdAt',${dt('l.created_at')}) FROM run_log_chunk l JOIN run r ON r.id=l.run_id
    JOIN agent_task t ON t.project_id=r.project_id WHERE t.id='${taskId}' AND t.project_id='${projectId}'
    AND l.created_at>=t.created_at`);
  const base = new URL(env.MANAO_AI_ACCEPTANCE_BASE_URL);
  requireEvidence(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password
    && base.pathname === '/' && !base.search && !base.hash, 'OWNER_BASE_URL');
  let token;
  const ownerApi = async (path, body) => {
    const response = await fetch(new URL(path, base), { method: body ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    requireEvidence(response.ok, 'OWNER_API_FAILED');
    return response.json();
  };
  const login = await ownerApi('/api/v1/auth/login', {
    username: env.MANAO_AI_ACCEPTANCE_USERNAME, password: env.MANAO_AI_ACCEPTANCE_PASSWORD });
  requireEvidence(nonempty(login.accessToken), 'OWNER_LOGIN_FAILED');
  token = login.accessToken;
  const project = await ownerApi(`/api/v1/projects/${projectId}`);
  const { url } = ownerEndpoint(project, projectId);
  const fixture = await ownerApi(`/api/v1/projects/${projectId}/files/content?path=${encodeURIComponent(FIXTURE)}`);
  requireEvidence(typeof fixture.content === 'string', 'FIXTURE_MISSING');
  const expectedFixture = readFileSync(new URL('../tests/fixtures/ai-stage2/DemoControllerAcceptanceTest.java', import.meta.url));
  const serviceRead = async () => JSON.parse(await execute(env.MANAO_AI_VERIFY_KUBECTL ?? 'kubectl',
    ['--context', env.MANAO_AI_VERIFY_KUBE_CONTEXT, '--namespace', env.MANAO_AI_VERIFY_KUBE_NAMESPACE,
      'get', 'service', `manao-app-${projectId}`, '-o', 'json']));
  const clock = async () => (await query(`SELECT JSON_OBJECT('now',${dt('CURRENT_TIMESTAMP(6)')})
    WHERE EXISTS(SELECT 1 FROM agent_task WHERE ${taskScope})`))[0].now;
  const activeRead = async () => {
    const active = await query(`${runSelect} AND r.active_run_marker=1`);
    requireEvidence(active.length === 1, 'INDEPENDENT_ACTIVE_UNKNOWN');
    return active[0];
  };
  const beforeAt = await clock(), activeBefore = await activeRead(), serviceBefore = await serviceRead();
  const { primary } = ownerEndpoint(project, projectId);
  verifyService(serviceBefore, projectId, activeBefore, primary);
  const http = await publicGet(url);
  const serviceAfter = await serviceRead(), activeAfter = await activeRead(), afterAt = await clock();
  // A final re-read detects changes during multi-SELECT evidence collection.
  const finalRuns = await query(runSelect);
  if (JSON.stringify(finalRuns.sort((a,b) => a.id.localeCompare(b.id)))
    !== JSON.stringify([...runs].sort((a,b) => a.id.localeCompare(b.id)))) {
    console.log(JSON.stringify({ verdict: 'FAIL', stagePassGranted: false, failures: ['COLLECTION_RUN_CHANGED'],
      evidenceDiff: runEvidenceDiff(runs, finalRuns) }, null, 2));
    process.exitCode = 1;
    return;
  }
  const verdict = verifyStage2Ledger({ taskId, projectId,
    seed: { r0Id: env.MANAO_AI_ACCEPTANCE_R0_ID, revision: env.MANAO_AI_ACCEPTANCE_INITIAL_REVISION,
      fixtureSha256: sha(expectedFixture) }, task: taskRows[0], calls, runs, operations, logs,
    independent: { beforeAt, afterAt, activeBefore, activeAfter, serviceBefore, serviceAfter, project,
      fixtureSha256: sha(fixture.content), workspaceRevision: fixture.workspaceRevision,
      runId: activeBefore.id, path: HTTP_PATH, url, ...http } });
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = verdict.verdict === 'PASS' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'OPERATOR_VERIFICATION_FAILED';
    console.log(JSON.stringify({ verdict: 'FAIL', stagePassGranted: false, failures: [code] }));
    process.exitCode = 1;
  });
}
