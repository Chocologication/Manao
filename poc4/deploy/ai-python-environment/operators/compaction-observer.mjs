/** Temporary operator observer. Never import this into the worker.
 * Node >=24; external loopback inspector only. Debugger pauses the whole isolate,
 * so metadata capture is bounded and every exit attempts resume before detach.
 * Node inspector docs: https://nodejs.org/docs/latest-v24.x/api/inspector.html
 *
 * node compaction-observer.mjs --ws-url ws://127.0.0.1:19229/<id>
 *   --script-url file:///app/dist/pi-session.js --line <verified deployed line>
 *   --project-label <id> --task-label <id> [--wait-seconds 1800]
 *
 * Labels are operator input. Only a readable scope taskId is compared; this does
 * not establish project ownership or the identity of the forwarded Pod/image.
 */
import { createHash } from 'node:crypto';

const allowed = new Set(['ws-url', 'script-url', 'line', 'project-label', 'task-label', 'wait-seconds', 'pause-timeout-ms']);

function argumentsOf(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !allowed.has(key) || args[i + 1] === undefined) throw new Error('INVALID_ARGUMENTS');
    values[key] = args[i + 1];
  }
  const url = new URL(values['ws-url']);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash)
    throw new Error('LOOPBACK_URL_REQUIRED');
  const script = new URL(values['script-url']);
  if (script.protocol !== 'file:' || script.username || script.password || script.search || script.hash) throw new Error('FILE_SCRIPT_URL_REQUIRED');
  for (const key of ['project-label', 'task-label'])
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(values[key] ?? '')) throw new Error('LABEL_REQUIRED');
  const integer = (key, fallback, min, max) => {
    const text = values[key] ?? String(fallback);
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('INVALID_BOUND');
    return value;
  };
  return { wsUrl: url.href, scriptUrl: script.href, line: integer('line', 0, 1, 100000),
    projectLabel: values['project-label'], taskLabel: values['task-label'],
    waitSeconds: integer('wait-seconds', 1800, 1, 1800), pauseMs: integer('pause-timeout-ms', 1000, 50, 2000) };
}

// Pure property reads only. throwOnSideEffect rejects getters that mutate target
// state. Raw summary is bounded and is hashed locally, never emitted or persisted.
const metadataExpression = `({
  type: event.type, reason: event.reason, aborted: event.aborted,
  observedTaskId: typeof taskId === 'string' ? taskId : null,
  hasResult: !!event.result,
  tokensBefore: event.result?.tokensBefore,
  estimatedTokensAfter: event.result?.estimatedTokensAfter,
  summary: typeof event.result?.summary === 'string' && event.result.summary.length <= 262144 ? event.result.summary : null,
  usage: event.result?.usage ? {
    input: event.result.usage.input, output: event.result.usage.output,
    cacheRead: event.result.usage.cacheRead, cacheWrite: event.result.usage.cacheWrite,
    totalTokens: event.result.usage.totalTokens
  } : null
})`;

async function observe(config) {
  const socket = new WebSocket(config.wsUrl);
  let sequence = 0, breakpointId, closing = false, finished = false, waitTimer;
  const pending = new Map();
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const emit = (status, data = {}) => process.stdout.write(`${JSON.stringify({
    status, at: new Date().toISOString(), projectLabel: config.projectLabel,
    taskLabel: config.taskLabel, projectIdentityVerified: false, ...data,
  })}\n`);
  const request = (method, params = {}, timeout = config.pauseMs) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP_TIMEOUT')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch { clearTimeout(timer); pending.delete(id); reject(new Error('CDP_UNAVAILABLE')); }
  });
  const resume = () => request('Debugger.resume').catch(() => {});
  const finish = async (code, status) => {
    if (closing) return;
    closing = true;
    clearTimeout(waitTimer);
    // Resume FIRST; removing breakpoints / disabling debugging is additional
    // cleanup, never a prerequisite that could leave the target paused.
    await resume();
    if (breakpointId) await request('Debugger.removeBreakpoint', { breakpointId }).catch(() => {});
    await request('Debugger.disable').catch(() => {});
    try { socket.close(); } catch { /* An unopened connection has no debugger state. */ }
    finished = true;
    emit(status);
    resolveDone(code);
  };
  const capture = async params => {
    if (closing || !params.hitBreakpoints?.includes(breakpointId)) { await resume(); return; }
    let expired = false;
    const watchdog = setTimeout(() => {
      expired = true;
      void resume().finally(() => finish(2, 'PAUSE_TIMEOUT'));
    }, config.pauseMs);
    let row, failure;
    try {
      const result = await request('Debugger.evaluateOnCallFrame', {
        callFrameId: params.callFrames[0].callFrameId, expression: metadataExpression,
        returnByValue: true, silent: true, throwOnSideEffect: true,
      });
      if (result.exceptionDetails || !result.result?.value) throw new Error('METADATA_UNAVAILABLE');
      const metadata = result.result.value;
      if (metadata.observedTaskId !== null && metadata.observedTaskId !== config.taskLabel) throw new Error('TASK_ID_MISMATCH');
      if (!['compaction_start', 'compaction_end'].includes(metadata.type)
        || !['threshold', 'overflow', 'manual'].includes(metadata.reason)) throw new Error('INVALID_EVENT');
      const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      row = { type: metadata.type, reason: metadata.reason,
        taskIdentityVerified: metadata.observedTaskId === config.taskLabel,
        aborted: typeof metadata.aborted === 'boolean' ? metadata.aborted : null,
        hasResult: metadata.hasResult === true, tokensBefore: number(metadata.tokensBefore),
        estimatedTokensAfter: number(metadata.estimatedTokensAfter),
        summarySha256: typeof metadata.summary === 'string' ? createHash('sha256').update(metadata.summary, 'utf8').digest('hex') : null,
        usage: metadata.usage ? Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].map(key => [key, number(metadata.usage[key])])) : null,
        usageSource: metadata.usage ? 'compaction-provider-result' : null };
    } catch (error) { failure = error.message === 'TASK_ID_MISMATCH' ? 'TASK_ID_MISMATCH' : 'METADATA_UNAVAILABLE'; }
    finally { await resume(); clearTimeout(watchdog); }
    if (expired || closing) return;
    if (failure) { await finish(2, failure); return; }
    emit('EVENT', row);
    if (row.type === 'compaction_end') await finish(row.hasResult && row.aborted === false ? 0 : 2, 'FINISHED');
  };
  socket.addEventListener('message', message => {
    let data;
    try { data = JSON.parse(message.data); } catch { void finish(2, 'INVALID_PROTOCOL'); return; }
    if (data.id !== undefined) {
      const item = pending.get(data.id);
      if (!item) return;
      pending.delete(data.id); clearTimeout(item.timer);
      if (data.error) item.reject(new Error('CDP_COMMAND_FAILED')); else item.resolve(data.result ?? {});
    } else if (data.method === 'Debugger.paused') void capture(data.params).catch(() => finish(2, 'CAPTURE_FAILED'));
  });
  socket.addEventListener('close', () => {
    clearTimeout(waitTimer);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP_DISCONNECTED')); }
    pending.clear();
    if (!closing && !finished) { emit('DISCONNECTED'); resolveDone(2); }
  });
  socket.addEventListener('error', () => { if (!closing) void finish(2, 'CONNECTION_FAILED'); });
  const interrupt = () => { void finish(2, 'INTERRUPTED'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CONNECT_TIMEOUT')), config.pauseMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CONNECT_FAILED')); }, { once: true });
    });
    await request('Debugger.enable');
    const breakpoint = await request('Debugger.setBreakpointByUrl', { url: config.scriptUrl, lineNumber: config.line - 1,
      condition: 'event.type === "compaction_start" || event.type === "compaction_end"' });
    breakpointId = breakpoint.breakpointId;
    emit('ARMED', { line: config.line, boundLocations: breakpoint.locations?.length ?? 0, taskIdentityVerified: false });
    waitTimer = setTimeout(() => { void finish(2, 'TIMEOUT'); }, config.waitSeconds * 1000);
  } catch { await finish(2, 'ATTACH_FAILED'); }
  const code = await done;
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  return code;
}

try { process.exitCode = await observe(argumentsOf(process.argv.slice(2))); }
catch { process.stdout.write('{"status":"INVALID_ARGUMENTS"}\n'); process.exitCode = 2; }
