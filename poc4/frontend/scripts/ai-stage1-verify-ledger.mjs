#!/usr/bin/env node
/**
 * AI stage one: OPERATOR-SIDE ledger verification (pi-stage1 plan Task 6; NOT the
 * browser). Reads the backend's durable task/tool-call ledger for ONE settled task
 * and fails unless the real coding-and-repair loop is fully evidenced:
 *
 *   1. the task is COMPLETED with failure_code IS NULL and no failure code — a
 *      COMPLETED row that carries any failure code FAILS the verdict;
 *   2. EVERY tool call is COMPLETED (a NEEDS_ATTENTION/REGISTERED/RUNNING row is an
 *      unfinished side effect and fails the verdict);
 *   3. the FIRST build carries a real, non-null, non-zero exitCode (the failing
 *      confirmation run) — a missing exit code fails the verdict, never passes it;
 *   4. at least one COMPLETED write_file with a receipt (workspace_operation_id)
 *      repaired src/main/java/com/example/app/DemoController.java AFTER that build;
 *   5. a LATER build ran goal=test, exited 0, carried NO persisted rejection
 *      (data.error), had cleanupConfirmed=true with the full Job identity
 *      (job_name/job_uid/pod_uid), and its testReports contain
 *      com.example.app.DemoControllerAcceptanceTest with tests>=1,
 *      failures=0, errors=0, skipped=0. A missing report, a reportsDropped flag,
 *      or any skipped/failed/errored count FAILS the verdict. A model that only
 *      ran compile, skipped the tests, or finished after a failed build cannot
 *      satisfy this;
 *   6. EVERY build has a non-null exitCode and cleanupConfirmed=true with its Job
 *      identity — unconfirmed cleanup fails the verdict.
 *
 * This script is run BY THE ACCEPTANCE OPERATOR against the backend database with
 * read-only credentials; the browser never holds a token for it and never runs it.
 * It issues SELECT statements only — the transport and the SQL are fixed below.
 *
 * Transport (dependency-free): the script spawns a MySQL client command and feeds
 * it SELECTs. Defaults to `mysql` on PATH; for a containerized client set
 *   MANAO_AI_VERIFY_MYSQL_CMD="docker run --rm -i mysql:8.0.40 mysql"
 * (args are split on spaces; the command runs WITHOUT a shell). The password is
 * passed through the client process's MYSQL_PWD environment variable by default;
 * container transports do not inherit it, so for those set
 *   MANAO_AI_VERIFY_MYSQL_PASSWORD_MODE=arg
 * which appends -p<password> to the client argv instead (visible only in the
 * local process list of the operator machine; this script never logs it).
 *
 * Usage:
 *   MANAO_AI_VERIFY_DB_HOST=<host> MANAO_AI_VERIFY_DB_PORT=3306 \
 *   MANAO_AI_VERIFY_DB_NAME=<schema> MANAO_AI_VERIFY_DB_USER=<readonly user> \
 *   MANAO_AI_VERIFY_DB_PASSWORD=<secret> \
 *   MANAO_AI_ACCEPTANCE_PROJECT_ID=<id> MANAO_AI_ACCEPTANCE_TASK_ID=<taskId> \
 *   [MANAO_AI_ACCEPTANCE_INITIAL_REVISION=<n>] \
 *   node scripts/ai-stage1-verify-ledger.mjs
 *
 * Exit 0 = every rule above held (the JSON verdict is printed). Exit 1 = at least
 * one rule failed; every failure reason is listed. This script's PASS is a
 * mandatory step of the stage-one acceptance (deploy README section 7, step 4).
 */

import { spawn } from 'node:child_process';

const TASK_ID = process.env.MANAO_AI_ACCEPTANCE_TASK_ID;
const PROJECT_ID = process.env.MANAO_AI_ACCEPTANCE_PROJECT_ID;
const DB_HOST = process.env.MANAO_AI_VERIFY_DB_HOST ?? '127.0.0.1';
const DB_PORT = process.env.MANAO_AI_VERIFY_DB_PORT ?? '3306';
const DB_NAME = process.env.MANAO_AI_VERIFY_DB_NAME;
const DB_USER = process.env.MANAO_AI_VERIFY_DB_USER;
const DB_PASSWORD = process.env.MANAO_AI_VERIFY_DB_PASSWORD;
const INITIAL_REVISION = process.env.MANAO_AI_ACCEPTANCE_INITIAL_REVISION;
const MYSQL_CMD = process.env.MANAO_AI_VERIFY_MYSQL_CMD ?? 'mysql';
const PASSWORD_MODE = process.env.MANAO_AI_VERIFY_MYSQL_PASSWORD_MODE ?? 'env';
const ACCEPTANCE_TEST_CLASS = 'com.example.app.DemoControllerAcceptanceTest';
const TARGET_FILE = 'src/main/java/com/example/app/DemoController.java';

for (const [name, value] of [
  ['MANAO_AI_ACCEPTANCE_TASK_ID', TASK_ID],
  ['MANAO_AI_ACCEPTANCE_PROJECT_ID', PROJECT_ID],
  ['MANAO_AI_VERIFY_DB_NAME', DB_NAME],
  ['MANAO_AI_VERIFY_DB_USER', DB_USER],
  ['MANAO_AI_VERIFY_DB_PASSWORD', DB_PASSWORD],
]) {
  if (!value) {
    console.error(`verify-ledger: ${name} is required (read-only operator access; nothing is written)`);
    process.exit(1);
  }
}
// The two ids are interpolated into the fixed SELECTs; only ledger-legal forms pass.
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(TASK_ID)) {
  console.error('verify-ledger: MANAO_AI_ACCEPTANCE_TASK_ID must be a canonical UUID');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,64}$/.test(PROJECT_ID)) {
  console.error('verify-ledger: MANAO_AI_ACCEPTANCE_PROJECT_ID has illegal characters');
  process.exit(1);
}

function runMysql(sql) {
  return new Promise((resolve, reject) => {
    // The transport command is operator infrastructure configuration (e.g. a
    // containerized client); it is split on spaces and spawned WITHOUT a shell,
    // so no part of the SQL or the credentials ever crosses a shell interpreter.
    const prefix = MYSQL_CMD.split(' ').filter(Boolean);
    const passwordArgs = PASSWORD_MODE === 'arg' ? [`-p${DB_PASSWORD}`] : [];
    const args = [...prefix, ...passwordArgs,
      '-h', DB_HOST, '-P', String(DB_PORT), '-u', DB_USER,
      '-D', DB_NAME, '--batch', '-N', '-e', sql];
    const env = { ...process.env };
    if (PASSWORD_MODE !== 'arg') {
      env.MYSQL_PWD = DB_PASSWORD;
    }
    const child = spawn(prefix[0], args.slice(1), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`mysql client exited ${code}: ${err.trim().slice(0, 400)}`));
    });
  });
}

/**
 * mysql --batch escapes \, newline and tab in output cells. Undo exactly that,
 * sentinel-first, so JSON documents (whose text contains \" and \n sequences of
 * its own) survive byte-exactly for JSON.parse.
 */
function unescapeCell(cell) {
  if (cell === undefined || cell === 'NULL') return null;
  return cell
    .replace(/\\\\/g, '\u0000')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\0/g, '\0')
    .split('\u0000').join('\\');
}

function parseJsonCell(cell) {
  const unescaped = unescapeCell(cell);
  return unescaped === null ? null : JSON.parse(unescaped);
}

async function query(sql) {
  const raw = await runMysql(sql);
  return raw.split('\n').filter((line) => line.length > 0)
    .map((line) => line.split('\t'));
}

const failures = [];
const notes = [];
function check(condition, okMessage, failMessage) {
  if (condition) {
    notes.push(`OK: ${okMessage}`);
  } else {
    failures.push(failMessage);
  }
}

// --- 1. The task row ---------------------------------------------------------
const taskRows = await query(
  `SELECT id, project_id, state, failure_code, workspace_revision FROM agent_task WHERE id = '${TASK_ID}'`);
check(taskRows.length === 1, `task ${TASK_ID} exists`,
  `task ${TASK_ID} not found in the ledger (1 row expected, got ${taskRows.length})`);
if (taskRows.length === 1) {
  const [id, projectId, state, failureCode, revision] = taskRows[0];
  check(projectId === PROJECT_ID, 'the task belongs to the acceptance project',
    `task project mismatch: ledger says ${projectId}, expected ${PROJECT_ID}`);
  check(state === 'COMPLETED', `task state COMPLETED at revision ${revision}`,
    `task state is ${state}; only COMPLETED passes`);
  // A COMPLETED row can still carry a failure code (for example an explicit
  // AI_* code from an earlier settle); that is never a passing verdict.
  check(failureCode === null || failureCode === 'NULL',
    'the task carries no failure code (failure_code IS NULL)',
    `task carries failure_code=${failureCode}; COMPLETED with a failure code cannot pass`);
  if (INITIAL_REVISION !== undefined) {
    check(Number(revision) > Number(INITIAL_REVISION),
      `final revision ${revision} is past the initial ${INITIAL_REVISION}`,
      `final revision ${revision} did not move past the initial ${INITIAL_REVISION}`);
  }
} else {
  failures.push('task row missing; the tool-call rules below cannot be evaluated');
}

// --- 2..6. The tool-call ledger ---------------------------------------------
// Ordering is the ledger's created_at only (the worker executes tools strictly
// sequentially, so microsecond timestamps are the recorded truth). A shared
// timestamp would make the loop-shape verdict guesswork, so identical stamps
// FAIL the verdict instead of being tie-broken by the random tool_call_id.
const callRows = await query(
  `SELECT tool_call_id, tool_name, state, workspace_operation_id, job_name, job_uid, pod_uid, result_json, created_at
   FROM agent_tool_call WHERE task_id = '${TASK_ID}' ORDER BY created_at`);
const stamps = callRows.map((row) => row[8]);
const duplicateStamps = stamps.filter((stamp, index) => stamps.indexOf(stamp) !== index);
check(duplicateStamps.length === 0,
  'tool-call timestamps are distinct (unambiguous execution order)',
  `ambiguous tool-call order: created_at values are not distinct (${duplicateStamps[0] ?? '?'}); the loop shape cannot be judged honestly from this ledger`);
check(callRows.length > 0, `${callRows.length} tool calls registered`,
  'no tool calls registered for the task; a real loop must have builds and writes');

const calls = callRows.map((row) => ({
  toolCallId: row[0],
  toolName: row[1],
  state: row[2],
  operationId: unescapeCell(row[3]),
  jobName: unescapeCell(row[4]),
  jobUid: unescapeCell(row[5]),
  podUid: unescapeCell(row[6]),
  result: parseJsonCell(row[7]),
}));

const unsettled = calls.filter((call) => call.state !== 'COMPLETED');
check(unsettled.length === 0,
  `every tool call is COMPLETED (${calls.length}/${calls.length})`,
  `unfinished tool calls: ${unsettled.map((call) => `${call.toolName}#${call.toolCallId}[${call.state}]`).join(', ')}`);

const builds = calls.filter((call) => call.toolName === 'build' && call.state === 'COMPLETED');
const writes = calls.filter((call) => call.toolName === 'write_file' && call.state === 'COMPLETED');

for (const call of calls) {
  if (call.result?.data?.error !== undefined) {
    notes.push(`note: ${call.toolName}#${call.toolCallId} carries a persisted rejection: ${call.result.data.error.code ?? ''}`);
  }
}

// Every build: real exit code, confirmed cleanup, full Job identity.
for (const call of builds) {
  const data = call.result?.data ?? {};
  const label = `build#${call.toolCallId}(goal=${data.goal ?? '?'})`;
  check(data.exitCode !== undefined && data.exitCode !== null,
    `${label} recorded a real exit code (${data.exitCode})`,
    `${label} has no recorded exit code (exitCode=${JSON.stringify(data.exitCode ?? null)}); a build without a real exit result can never pass`);
  check(data.cleanupConfirmed === true,
    `${label} cleanup confirmed`,
    `${label} cleanupConfirmed=${JSON.stringify(data.cleanupConfirmed ?? null)}; unconfirmed development cleanup fails the verdict`);
  check(call.jobName !== null && call.jobUid !== null && call.podUid !== null,
    `${label} carries the full Job/Pod identity`,
    `${label} is missing its Job identity (job=${call.jobName ?? 'null'}, uid=${call.jobUid ?? 'null'}, pod=${call.podUid ?? 'null'})`);
}

check(builds.length >= 2,
  `at least two real builds ran (${builds.length})`,
  `only ${builds.length} completed build(s); the repair loop needs the failing run and the verification run`);

// The failing confirmation run: first build, non-zero exit.
const firstBuild = builds[0];
if (firstBuild) {
  const exit = firstBuild.result?.data?.exitCode;
  check(typeof exit === 'number' && exit !== 0,
    `the first build failed for real (exitCode=${exit})`,
    `the first build did not record a non-zero exit (exitCode=${JSON.stringify(exit ?? null)}); the loop must start from the real failure`);
}

// The repaired file: a receipted write to the target path after the first build.
const firstBuildIndex = calls.indexOf(firstBuild);
const targetWrites = writes.filter((call) => {
  const afterFirstBuild = calls.indexOf(call) > firstBuildIndex;
  return afterFirstBuild && call.result?.data?.path === TARGET_FILE;
});
check(targetWrites.length > 0,
  `the target file was really written after the failing build (${targetWrites.length} receipted write(s))`,
  `no COMPLETED write_file for ${TARGET_FILE} after the first build; the repair never reached the real file`);
for (const call of targetWrites) {
  check(typeof call.result?.data?.sha256 === 'string' && call.operationId !== null,
    `write#${call.toolCallId} has a receipt (operation ${call.operationId})`,
    `write#${call.toolCallId} lacks its file receipt (operation=${call.operationId ?? 'null'}, sha256=${call.result?.data?.sha256 ?? 'null'})`);
}

// The verification run: a later test build with exit 0 and the acceptance report.
const lastWriteIndex = writes.length > 0 ? Math.max(...writes.map((call) => calls.indexOf(call))) : -1;
const verificationBuilds = builds.filter((call) => {
  const data = call.result?.data ?? {};
  return data.goal === 'test' && data.exitCode === 0 && calls.indexOf(call) > lastWriteIndex;
});
check(verificationBuilds.length > 0,
  'a later goal=test build exited 0 after the last write',
  'no goal=test build with exitCode=0 after the last write; a loop that only compiled, skipped the tests, or ended on a failed build cannot pass');

let reportVerified = false;
for (const call of verificationBuilds) {
  const data = call.result?.data ?? {};
  // A persisted rejection (data.error) is a deterministic refusal, never a
  // passing verification build — the successful build must be error-free.
  if (data.error !== undefined) {
    failures.push(`verification build#${call.toolCallId} carries a persisted rejection (data.error=${JSON.stringify(data.error)}); a refused build cannot be the verification run`);
    continue;
  }
  if (data.reportsDropped === true) {
    failures.push(`verification build#${call.toolCallId} dropped its test reports (reportsDropped=true); the Surefire evidence was not retained`);
    continue;
  }
  const reports = Array.isArray(data.testReports) ? data.testReports : [];
  const report = reports.find((entry) => entry.testClass === ACCEPTANCE_TEST_CLASS);
  if (!report) {
    failures.push(`verification build#${call.toolCallId} has no Surefire report for ${ACCEPTANCE_TEST_CLASS} (reports: ${reports.map((entry) => entry.testClass).join(', ') || 'none'})`);
    continue;
  }
  check(Number(report.tests) >= 1 && Number(report.failures) === 0
        && Number(report.errors) === 0 && Number(report.skipped) === 0,
    `verification build#${call.toolCallId} report: tests=${report.tests} failures=${report.failures} errors=${report.errors} skipped=${report.skipped}`,
    `verification build#${call.toolCallId} report for ${ACCEPTANCE_TEST_CLASS}: tests=${report.tests}, failures=${report.failures}, errors=${report.errors}, skipped=${report.skipped}; tests>=1 and zero failures/errors/skipped required`);
  if (Number(report.tests) >= 1 && Number(report.failures) === 0
      && Number(report.errors) === 0 && Number(report.skipped) === 0) {
    reportVerified = true;
  }
}
check(reportVerified, 'the acceptance test report proves tests>=1 with zero failures/errors/skipped',
  'no verification build carried a passing Surefire report for the acceptance test');

// --- Verdict -----------------------------------------------------------------
const verdict = {
  script: 'ai-stage1-verify-ledger',
  taskId: TASK_ID,
  projectId: PROJECT_ID,
  verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  failures,
  notes,
  checkedAt: new Date().toISOString(),
};
console.log(JSON.stringify(verdict, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
