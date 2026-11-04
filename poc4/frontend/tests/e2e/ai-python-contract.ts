import assert from 'node:assert/strict';

export type ToolResult = { toolCallId: string; toolName: string; data: Record<string, unknown> };
const required = ['MANAO_AI_ACCEPTANCE_BASE_URL', 'MANAO_AI_ACCEPTANCE_USERNAME', 'MANAO_AI_ACCEPTANCE_PASSWORD',
  'MANAO_AI_PYTHON_CONSOLE_PROJECT_ID', 'MANAO_AI_PYTHON_FASTAPI_PROJECT_ID'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function acceptanceEnvironment(input: Record<string, string | undefined>) {
  const missing = required.filter(name => !input[name]?.trim());
  if (missing.length) throw new Error(`NOT_RUN: missing environment names: ${missing.join(', ')}`);
  let parsed: URL;
  try { parsed = new URL(input.MANAO_AI_ACCEPTANCE_BASE_URL!); } catch { throw new Error('Invalid MANAO_AI_ACCEPTANCE_BASE_URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Invalid MANAO_AI_ACCEPTANCE_BASE_URL: an HTTP(S) origin without credentials is required');
  }
  for (const name of required.slice(3)) if (!uuid.test(input[name]!)) throw new Error(`Invalid ${name}`);
  if (input.MANAO_AI_PYTHON_CONSOLE_PROJECT_ID!.toLowerCase() === input.MANAO_AI_PYTHON_FASTAPI_PROJECT_ID!.toLowerCase()) {
    throw new Error('Distinct MANAO_AI_PYTHON_CONSOLE_PROJECT_ID and MANAO_AI_PYTHON_FASTAPI_PROJECT_ID required');
  }
  return { baseURL: parsed.origin, username: input.MANAO_AI_ACCEPTANCE_USERNAME!, password: input.MANAO_AI_ACCEPTANCE_PASSWORD!,
    consoleProjectId: input.MANAO_AI_PYTHON_CONSOLE_PROJECT_ID!, fastapiProjectId: input.MANAO_AI_PYTHON_FASTAPI_PROJECT_ID! };
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'Structured acceptance evidence required');
  return value as Record<string, unknown>;
}
export function assertDisposableProject(project: unknown, id: string, template: string, task: unknown, run: unknown, pending: unknown[]): void {
  const p = record(project);
  assert.equal(p.id, id, 'Explicit owner project identity required');
  assert.ok(typeof p.name === 'string' && /^ai-python-acceptance-[a-z0-9-]+$/.test(p.name), 'Dedicated ai-python-acceptance-* project required');
  assert.equal(p.state, 'READY'); assert.equal(record(p.runtime).templateId, template);
  assert.equal(task, null, 'Project has an occupying task'); assert.equal(run, null, 'Project has an active Run');
  assert.equal(pending.length, 0, 'Project has unresolved dependency operations');
}
export function assertPythonRound(rows: ToolResult[], expected: { kind: 'console' | 'fastapi'; output: string; first: boolean }): void {
  const builds = rows.filter(r => r.toolName === 'build');
  for (const build of builds) assert.equal(build.data.cleanupConfirmed, true, 'Every observed build must prove Job/Pod cleanup');
  const passed = builds.filter(r => r.data.language === 'python' && r.data.checkKind === 'pytest' && r.data.verificationStatus === 'PASS');
  assert.ok(passed.length > 0, 'Real pytest PASS required');
  const test = passed.at(-1)!.data, summary = record(test.testSummary);
  assert.equal(test.exitCode, 0); assert.equal(summary.reportComplete, true);
  assert.ok(typeof summary.tests === 'number' && Number.isSafeInteger(summary.tests) && summary.tests > 0);
  assert.equal(summary.failures, 0); assert.equal(summary.errors, 0); assert.equal(summary.skipped, 0);
  assert.ok(typeof test.sourceRevision === 'string' && test.sourceRevision.length > 0);
  assert.ok(builds.some(r => r.data.language === 'python' && r.data.checkKind === 'syntax' && r.data.verificationStatus === 'PASS'
    && r.data.exitCode === 0 && Number(r.data.filesChecked) > 0 && r.data.sourceRevision === test.sourceRevision), 'Syntax PASS at verified revision required');
  if (expected.first) {
    assert.ok(rows.some((r, index) => r.toolName === 'build' && r.data.checkKind === 'pytest' && r.data.verificationStatus === 'FAILED'
      && Number(record(r.data.testSummary).failures) > 0 && rows.indexOf(passed.at(-1)!) > index), 'Initial assertion failure before repaired pytest PASS required');
    for (const group of ['main', 'test']) {
      assert.ok(rows.some(r => {
        const d = r.data;
        return r.toolName === 'python_dependencies' && d.kind === 'python_dependencies' && d.state === 'COMMITTED' && d.action === 'add'
          && d.group === group && typeof d.operationId === 'string' && d.operationId.length > 0 && typeof d.packageName === 'string'
          && Array.isArray(d.changedPaths) && d.changedPaths.length === 2 && d.changedPaths.includes('pyproject.toml') && d.changedPaths.includes('uv.lock');
      }), `Committed ${group} dependency pair required`);
    }
  }
  const application = rows.filter(r => r.toolName === 'application' && r.data.kind === 'application' && r.data.run != null);
  if (expected.kind === 'console') {
    assert.ok(application.some(r => {
      const run = record(r.data.run), logs = r.data.logs == null ? null : record(r.data.logs);
      return run.state === 'SUCCEEDED' && run.exitCode === 0 && run.requestedWorkspaceRevision === test.sourceRevision
        && logs?.complete === true && logs.truncated === false && typeof logs.text === 'string'
        && logs.text.split(/\r?\n/).some(line => line.trim() === expected.output);
    }), 'Successful Run with complete expected output at verified revision required');
  } else {
    const ready = application.map(r => record(r.data.run)).filter(run => run.state === 'RUNNING' && typeof run.firstReadyAt === 'string'
      && run.firstReadyAt.length > 0 && run.requestedWorkspaceRevision === test.sourceRevision);
    assert.ok(ready.length > 0, 'Live ready Run at verified revision required');
    assert.ok(rows.some(r => {
      const d = r.data;
      if (r.toolName !== 'app_http_get' || d.kind !== 'app_http_get' || d.path !== '/api/demo' || d.statusCode !== 200
        || d.error !== null || d.truncated !== false || !ready.some(run => run.id === d.runId) || typeof d.body !== 'string') return false;
      try { assert.deepEqual(JSON.parse(d.body), { message: 'Hello from Manao', total: expected.output }); return true; } catch { return false; }
    }), 'Exact business GET from the same ready Run required');
  }
}
