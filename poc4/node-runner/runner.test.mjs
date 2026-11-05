import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { copyProject, execute, runProject } from './runner.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pnpm = process.env.MANAO_TEST_PNPM;
assert.ok(pnpm && existsSync(pnpm), 'Set MANAO_TEST_PNPM to the pnpm@10.33.0 CLI');
const evidence = process.env.MANAO_TEST_OUTPUT ?? mkdtempSync(join(tmpdir(), 'manao-node-test-'));
mkdirSync(evidence, { recursive: true });
const resources = join(root, 'poc4/backend/src/main/resources');
const cache = join(evidence, 'cache');
const templateIds = ['node-javascript-console', 'node-javascript-web', 'node-typescript-console', 'node-typescript-web'];
function fixture(id) {
  const path = join(mkdtempSync(join(evidence, id + '-')), 'project');
  copyProject(join(resources, 'workspace-template-' + id), path);
  return path;
}
function command(log) {
  return async (_program, args, options) => {
    const fd = openSync(log, 'a');
    const { NODE_TEST_CONTEXT: _context, ...env } = options.env;
    try { return await execute(process.execPath, [pnpm, ...args], { ...options, env, stdio: ['ignore', fd, fd] }); }
    finally { closeSync(fd); }
  };
}
async function run(id, options = {}) {
  const log = join(evidence, id + '.log'), output = [];
  const code = await runProject({ cache, seed: undefined, output: line => output.push(line),
    executeCommand: command(log), ...options });
  return { code, output: output.join('\n'), log: readFileSync(log, 'utf8') };
}

for (const id of templateIds) {
  test(id + ': real frozen install, compile and JUnit test report', { timeout: 180000 }, async () => {
    const workspace = fixture(id);
    const result = await run(id, { mode: 'build', goal: 'test', workspace });
    assert.equal(result.code, 0, result.log);
    assert.match(result.output, /MANAO-SUREFIRE-REPORT-END truncated=0 files=1 state=ok/);
    assert.equal((result.output.match(/<testcase /g) ?? []).length, 2);
    assert.doesNotMatch(result.output, /<failure[\s>]/);
    assert.ok(existsSync(join(workspace, '.manao-test-results.xml')));
    writeFileSync(join(evidence, id + '.xml'), readFileSync(join(workspace, '.manao-test-results.xml')));
    if (id.includes('typescript')) assert.ok(existsSync(join(workspace, 'dist/main.js')));
  });
}

for (const id of templateIds.filter(id => id.endsWith('console'))) {
  test(id + ': real run keeps the workspace clean', { timeout: 90000 }, async () => {
    const workspace = fixture(id), scratch = mkdtempSync(join(evidence, 'scratch-'));
    const before = readdirSync(workspace);
    const result = await run(id + '-console', { mode: 'console', workspace, temporaryRoot: scratch });
    assert.equal(result.code, 0, result.log); assert.match(result.log, /Hello, Manao!/);
    assert.deepEqual(readdirSync(workspace), before);
    assert.equal(existsSync(join(workspace, 'node_modules')), false);
    assert.equal(existsSync(join(workspace, 'dist')), false);
    assert.deepEqual(readdirSync(scratch), []);
  });
}

for (const id of templateIds.filter(id => id.endsWith('web'))) {
  test(id + ': real HTTP readiness, 404 and process-tree stop', { timeout: 90000 }, async () => {
    const workspace = fixture(id), controller = new AbortController();
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; reservation.close(); await once(reservation, 'close');
    const base = 'http://127.0.0.1:' + port;
    const running = run(id + '-web', { mode: 'web', workspace, signal: controller.signal,
      env: { ...process.env, MANAO_PRIMARY_PORT: String(port) } });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        try { ready = (await fetch(base + '/health/ready', { signal: AbortSignal.timeout(500) })).status === 200; }
        catch {} if (ready) break; await delay(100);
      }
      assert.equal(ready, true, 'Service did not become ready');
      assert.deepEqual(await (await fetch(base)).json(), { message: 'Hello from Manao Node.js!' });
      assert.equal((await fetch(base + '/missing')).status, 404);
    } finally { controller.abort(); }
    const result = await running; assert.notEqual(result.code, 0);
    await assert.rejects(fetch(base, { signal: AbortSignal.timeout(1000) }));
    assert.equal(existsSync(join(workspace, 'node_modules')), false);
  });
}

test('nonzero application exit and compilation failure stay failures', { timeout: 90000 }, async () => {
  const workspace = fixture('node-javascript-console');
  writeFileSync(join(workspace, 'src/main.js'), 'process.exit(7);\n');
  const result = await run('nonzero', { mode: 'console', workspace });
  assert.equal(result.code, 7, result.log);
  writeFileSync(join(workspace, 'src/main.js'), 'invalid syntax !!!\n');
  assert.notEqual((await run('compile-failure', { mode: 'console', workspace })).code, 0);
});

test('lock mismatch fails and package goal creates a real archive', { timeout: 90000 }, async () => {
  const workspace = fixture('node-typescript-console');
  const pkgPath = join(workspace, 'package.json'), pkg = JSON.parse(readFileSync(pkgPath));
  pkg.devDependencies.typescript = '5.8.3'; writeFileSync(pkgPath, JSON.stringify(pkg));
  const bad = await run('lock-mismatch', { mode: 'build', goal: 'compile', workspace });
  assert.notEqual(bad.code, 0); assert.match(bad.log, /OUTDATED_LOCKFILE/);
  pkg.devDependencies.typescript = '5.9.3'; writeFileSync(pkgPath, JSON.stringify(pkg));
  const packages = mkdtempSync(join(evidence, 'packages-'));
  const good = await run('package', { mode: 'build', goal: 'package', workspace, temporaryRoot: packages });
  assert.equal(good.code, 0, good.log);
  assert.ok(readdirSync(packages).some(dir => readdirSync(join(packages, dir)).some(file => file.endsWith('.tgz'))));
});

test('generated dependency and output directories are excluded from source copy', () => {
  const workspace = fixture('node-javascript-console');
  for (const directory of ['node_modules', 'dist', 'coverage']) {
    mkdirSync(join(workspace, directory)); writeFileSync(join(workspace, directory, 'generated'), 'ignored');
  }
  const target = join(mkdtempSync(join(evidence, 'copy-')), 'workspace');
  copyProject(workspace, target);
  for (const directory of ['node_modules', 'dist', 'coverage']) assert.equal(existsSync(join(target, directory)), false);
  assert.equal(existsSync(join(target, 'src/main.js')), true);
});
