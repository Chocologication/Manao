import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const operator = new URL('./compaction-observer.mjs', import.meta.url);
const secret = 'NEVER_PRINT_PROVIDER_SECRET_9bcdf';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'manao-compaction-observer-'));
  const path = join(directory, 'pi-session.mjs');
  const source = [
    'const taskId = "task-expected";',
    'function observe(event) {',
    '  if (event.type === "compaction_start") void taskId;',
    '  process.send({ completed: event.type });',
    '}',
    'process.on("message", event => { if (event.invalidResult) Object.defineProperty(event, "result", { get() { throw new Error("NEVER_PRINT_PROVIDER_SECRET_9bcdf"); } }); observe(event); });',
    'process.send({ ready: true });',
  ].join('\n');
  await writeFile(path, source, 'utf8');
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '', messages = [];
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => { messages.push(message); });
  t.after(async () => { child.kill(); await rm(directory, { recursive: true, force: true }); });
  await until(() => messages.some(message => message.ready) && /ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.test(stderr));
  return { child, url: stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)[0], scriptUrl: pathToFileURL(path).href, messages };
}

async function until(predicate, milliseconds = 6000) {
  const end = Date.now() + milliseconds;
  while (!predicate()) { assert.ok(Date.now() < end, 'condition timed out'); await pause(20); }
}

function start(f, extra = []) {
  const process = spawn(globalThis.process.execPath, [fileURLToPath(operator),
    '--ws-url', f.url, '--script-url', f.scriptUrl, '--line', '3',
    '--project-label', 'project-label-only', '--task-label', 'task-expected', '--wait-seconds', '5', ...extra],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const result = { stdout: '', stderr: '', code: null, exited: false };
  process.stdout.on('data', chunk => { result.stdout += chunk; });
  process.stderr.on('data', chunk => { result.stderr += chunk; });
  process.on('exit', code => { result.code = code; result.exited = true; });
  return { process, result };
}

test('observes real conditional events and resumes without leaking transcript or secrets', { timeout: 15000 }, async t => {
  const f = await fixture(t), o = start(f); t.after(() => o.process.kill());
  await until(() => o.result.stdout.includes('ARMED') || o.result.exited);
  assert.equal(o.result.exited, false, 'observer must attach and arm');
  f.child.send({ type: 'message_end', text: secret });
  f.child.send({ type: 'compaction_start', reason: 'threshold', secret });
  f.child.send({ type: 'compaction_end', reason: 'threshold', aborted: false,
    result: { tokensBefore: 786500, estimatedTokensAfter: 421, summary: secret, usage: { input: 786490, output: 90, cacheRead: 0, cacheWrite: 0, totalTokens: 786580 }, secret } });
  await until(() => o.result.exited);
  assert.equal(o.result.code, 0, o.result.stderr);
  const events = o.result.stdout.trim().split('\n').map(JSON.parse).filter(row => row.status === 'EVENT');
  assert.deepEqual(events.map(row => row.type), ['compaction_start', 'compaction_end']);
  assert.equal(events[0].reason, 'threshold');
  assert.equal(events[1].tokensBefore, 786500);
  assert.equal(events[1].usage.input, 786490);
  assert.equal(events[1].summarySha256, 'ceb94d91e519a928a08722dc2154a427eba5d3f90e0666896bbc1aea2eb1dcfe');
  assert.equal(events[1].usageSource, 'compaction-provider-result');
  assert.equal(events[0].taskIdentityVerified, true);
  assert.equal(events[0].projectIdentityVerified, false);
  assert.ok(!`${o.result.stdout}${o.result.stderr}`.includes(secret));
  await until(() => f.messages.filter(message => message.completed).length === 3);
});

test('a bounded observation timeout removes the breakpoint and leaves target responsive', { timeout: 15000 }, async t => {
  const f = await fixture(t), o = start(f, ['--wait-seconds', '1']); t.after(() => o.process.kill());
  await until(() => o.result.exited);
  assert.equal(o.result.code, 2);
  assert.match(o.result.stdout, /TIMEOUT/);
  f.child.send({ type: 'compaction_start', reason: 'threshold', secret });
  await until(() => f.messages.some(message => message.completed === 'compaction_start'));
  assert.ok(!`${o.result.stdout}${o.result.stderr}`.includes(secret));
});

test('a mismatched scope task is rejected while target still resumes', { timeout: 15000 }, async t => {
  const f = await fixture(t), o = start(f, ['--task-label', 'different-task']); t.after(() => o.process.kill());
  await until(() => o.result.stdout.includes('ARMED') || o.result.exited);
  assert.equal(o.result.exited, false);
  f.child.send({ type: 'compaction_start', reason: 'threshold', secret });
  await until(() => o.result.exited);
  assert.equal(o.result.code, 2);
  assert.match(o.result.stdout, /TASK_ID_MISMATCH/);
  assert.ok(!o.result.stdout.includes('"status":"EVENT"'));
  await until(() => f.messages.some(message => message.completed === 'compaction_start'));
});

test('rejects non-loopback inspector URLs without echoing URL credentials', { timeout: 10000 }, async () => {
  const o = start({ url: `ws://user:${secret}@example.com:9229/id`, scriptUrl: 'file:///app/dist/pi-session.js' });
  await until(() => o.result.exited);
  assert.equal(o.result.code, 2);
  assert.ok(!`${o.result.stdout}${o.result.stderr}`.includes(secret));
});

test('a metadata getter failure immediately resumes and never prints its secret exception', { timeout: 15000 }, async t => {
  const f = await fixture(t), o = start(f); t.after(() => o.process.kill());
  await until(() => o.result.stdout.includes('ARMED') || o.result.exited);
  assert.equal(o.result.exited, false);
  f.child.send({ type: 'compaction_start', reason: 'threshold', invalidResult: true });
  await until(() => o.result.exited);
  assert.equal(o.result.code, 2);
  assert.match(o.result.stdout, /METADATA_UNAVAILABLE/);
  assert.ok(!`${o.result.stdout}${o.result.stderr}`.includes(secret));
  await until(() => f.messages.some(message => message.completed === 'compaction_start'));
});
