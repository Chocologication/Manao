import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAiOutputEnvironment, assembleOutputHistory } from '../tests/e2e/ai-output-contract.ts';
import { JSDOM } from 'jsdom';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { installOutputAudit, assertOutputAnswerTiming, outputAnswerSelector } from '../tests/e2e/ai-output-observer.ts';

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

async function auditFixture(run) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' }); const win = dom.window;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.Response = Response;
  let controller; win.fetch = async () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  win.eval('(' + installOutputAudit.toString() + ')()'); await win.fetch('/tasks/task/live-output');
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  const frame = async (ordinal, phase, text, revision, thinking = false) => { controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify({ taskId: 'task', revision, durableHeadSeq: ordinal === 1 ? 1 : 3, current: { messageOrdinal: ordinal, phase, blocks: [...(thinking ? [{ kind: 'thinking', text: 'reason' }] : []), { kind: 'text', text }] } }) + '\n\n')); await tick(); };
  const visible = async (ordinal, text, thinking = true) => { win.document.body.innerHTML = '<article aria-label="实时预览" data-task-id="task" data-message-ordinal="' + ordinal + '">' + (thinking ? '<details open><pre>reason</pre></details>' : '') + '<div class="ai-markdown">' + text + '</div></article>'; await tick(); };
  try { await run({ win, frame, visible }); } finally { controller.close(); await tick(); win.outputObserver?.disconnect(); dom.window.close(); }
}
test('tool-only end does not reject the next answer with multiple generating snapshots', async () => {
  await auditFixture(async ({ win, frame, visible }) => {
    await frame(1, 'generating', '', 1); await visible(1, ''); await frame(1, 'ended', '', 2);
    await frame(2, 'generating', 'hello', 3); await visible(2, 'hello');
    await frame(2, 'generating', 'hello world', 4); await visible(2, 'hello world'); await frame(2, 'ended', 'hello world', 5);
    assert.doesNotThrow(() => assertOutputAnswerTiming(win.outputAudit, 'task', 2, false));
  });
});
test('pre-tool API thinking displayed before its own end proves task thinking independently of a text-only final answer', async () => {
  await auditFixture(async ({ win, frame, visible }) => {
    await frame(1, 'generating', '', 1, true); await visible(1, ''); await frame(1, 'ended', '', 2, true);
    await frame(2, 'generating', 'final', 3); await visible(2, 'final', false);
    await frame(2, 'generating', 'final answer', 4); await visible(2, 'final answer', false); await frame(2, 'ended', 'final answer', 5);
    assert.doesNotThrow(() => assertOutputAnswerTiming(win.outputAudit, 'task', 2, true));
    assert.throws(() => assertOutputAnswerTiming(win.outputAudit, 'other-task', 2, true), /UNVERIFIED/);
  });
});
test('visible DOM reasoning alone cannot prove API thinking coverage', async () => {
  await auditFixture(async ({ win, frame, visible }) => {
    await frame(1, 'generating', 'hello', 1); await visible(1, 'hello');
    await frame(1, 'generating', 'hello world', 2); await visible(1, 'hello world'); await frame(1, 'ended', 'hello world', 3);
    assert.throws(() => assertOutputAnswerTiming(win.outputAudit, 'task', 1, true), /UNVERIFIED/);
  });
});
test('a prior answer cannot prove a later answer whose text appears only after its own end', async () => {
  await auditFixture(async ({ win, frame, visible }) => {
    await frame(1, 'generating', 'preamble', 1); await visible(1, 'preamble'); await frame(1, 'generating', 'preamble tool', 2); await frame(1, 'ended', 'preamble tool', 3);
    await frame(2, 'generating', 'final', 4); await frame(2, 'generating', 'final answer', 5); await frame(2, 'ended', 'final answer', 6); await visible(2, 'final answer');
    assert.throws(() => assertOutputAnswerTiming(win.outputAudit, 'task', 2, false), /UNVERIFIED/);
  });
});
test('earlier round Markdown cannot satisfy the current plain-text answer', () => {
  const dom = new JSDOM('<article data-task-id="previous" data-message-seq="2"><div class="ai-markdown"><h1>Old</h1><ul><li>old</li></ul><table><tr><td>old</td></tr></table><pre><code>old</code></pre></div></article><article data-task-id="current" data-message-seq="5"><div class="ai-markdown"><p>plain text</p></div></article>');
  try {
    const answer = dom.window.document.querySelector(outputAnswerSelector('current', 5)); assert.ok(answer);
    for (const tag of ['h1', 'ul', 'table', 'pre code']) assert.equal(answer.querySelector(tag), null);
    assert.equal(answer.textContent, 'plain text');
  } finally { dom.window.close(); }
});

test('generating API thinking and its visible DOM interrupt only the first live fetch, preserving caller cancellation', async () => {
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (!request.url.endsWith('/live-output')) { response.end('<body></body>'); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: snapshot\ndata: ' + JSON.stringify({ taskId: 'task', revision: 1, durableHeadSeq: 1, current: { messageOrdinal: 1, phase: 'generating', blocks: [{ kind: 'thinking', text: 'local fixture only' }] } }) + '\n\n');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(installOutputAudit, { abortOnGeneratingThinking: true });
    const result = await page.evaluate(async () => {
      const caller = new AbortController();
      const response = await fetch('/tasks/task/live-output', { signal: caller.signal });
      const reader = response.body.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      document.body.innerHTML = '<article aria-label="实时预览" data-task-id="task" data-message-ordinal="1"><details open><pre>local fixture only</pre></details></article>';
      const interrupted = await Promise.race([reader.read().then(() => 'readable', error => error.name), new Promise(resolve => setTimeout(() => resolve('still-reading'), 1500))]);
      const callerAborted = caller.signal.aborted; caller.abort();
      const secondCaller = new AbortController();
      const second = await fetch('/tasks/task/live-output', { signal: secondCaller.signal });
      const secondReader = second.body.getReader();
      const secondData = new TextDecoder().decode((await secondReader.read()).value);
      secondCaller.abort();
      const secondInterruption = await secondReader.read().then(() => 'readable', error => error.name);
      return { first, secondData, interrupted, callerAborted, secondInterruption, audit: window.outputAudit };
    });
    assert.equal(result.interrupted, 'AbortError');
    assert.equal(result.callerAborted, false);
    assert.equal(result.secondInterruption, 'AbortError');
    assert.equal(result.first, result.secondData);
    assert.equal(result.audit.liveGets, 2);
    assert.equal(result.audit.reconnect.taskId, 'task');
    assert.equal(result.audit.reconnect.messageOrdinal, 1);
    assert.ok(result.audit.reconnect.abortedAt < result.audit.connections[1].requestedAt);
    assert.doesNotMatch(JSON.stringify(result.audit), /local fixture only/);
  } finally { await browser.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
});
