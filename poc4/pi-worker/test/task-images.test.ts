import { deflateSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentSession, SessionManager, SettingsManager, type AgentSession, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { ProgressChain, type BackendClient } from '../src/backend-client.js';
import { createPiSession } from '../src/pi-session.js';
import { JAVA_ENVIRONMENT } from './environment-fixtures.js';
import { MODEL_CONFIG, privateDirs, scriptedSessionFactory } from './scripted-session.js';

afterEach(() => vi.unstubAllGlobals());

// Valid, uncompressed-looking RGB PNG reproduces the upload-sized Base64 overflow.
function png(width: number, height: number) {
  function chunk(kind: string, bytes: Buffer) {
    const data = Buffer.concat([Buffer.from(kind), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), sum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, sum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  let seed = 123456789;
  for (let row = 0; row < height; row++) for (let col = 1; col <= width * 3; col++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    pixels[row * (width * 3 + 1) + col] = seed & 255;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function sse(tool: boolean) {
  const delta = tool ? { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }
    : { content: 'received task image' };
  return new Response(`data: ${JSON.stringify({ id: 'offline', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'offline', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } });
}

it.each([[1, 1], [900, 700]])('projects a %i x %i task image across tool rounds without persisting binary', async (width, height) => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: png(width, height).toString('base64') };
  const manager = SessionManager.inMemory('scratch', { id: 'conversation' });
  manager.appendCustomMessageEntry('manao_user_request', 'inspect task attachment', true, { taskId: 'task' });
  const entries = structuredClone(manager.getEntries());
  const backend = {
    readContext: vi.fn(async () => ({ header: manager.getHeader(), headSeq: entries.length,
      entries: entries.map((entry, index) => ({ seq: index + 1, sourceTaskId: 'task', writerId: 'task', entry })), nextAfterSeq: null })),
    appendContext: vi.fn(async (_task: string, batch: { entries: SessionEntry[] }) => {
      entries.push(...structuredClone(batch.entries)); return { headSeq: entries.length };
    }),
    imageCatalog: vi.fn(async () => ({ kind: 'image_catalog', items: [], nextCursor: null })),
    progress: vi.fn(async () => ({ accepted: true })),
    invoke: vi.fn(async () => ({ toolCallId: 'read', workspaceRevision: '7', data: { content: 'project source' }, truncated: false })),
  };
  let native!: AgentSession;
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    requests.push(String(init?.body)); return sse(requests.length === 1);
  });
  const task = await createPiSession({ environment: JAVA_ENVIRONMENT, model: { ...MODEL_CONFIG, imageInput: true },
    paths: privateDirs(), taskId: 'task', conversationId: 'conversation', backend: backend as unknown as BackendClient,
    progress: new ProgressChain(backend as unknown as BackendClient, 'task'),
    deps: { createSession: async options => { const made = await createAgentSession(options); native = made.session; return made; } } });
  try {
    const outcome = await task.run({ prompt: 'inspect task attachment', workspaceRevision: '7', images: [image] });
    expect(outcome.state, JSON.stringify(outcome)).toBe('COMPLETED');
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.split('data:image/png;base64,' + image.data)).toHaveLength(2);
    expect(backend.invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(entries)).not.toContain(image.data);
    expect(JSON.stringify(native.agent.state.messages)).not.toContain(image.data);
    expect(entries.every(entry => Buffer.byteLength(JSON.stringify(entry)) <= 2 * 1024 * 1024)).toBe(true);
  } finally { task.dispose(); }
});

it('compacts without task image bytes, keeps them in the live request and restores history without them', async () => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: png(900, 700).toString('base64') };
  const manager = SessionManager.inMemory('scratch', { id: 'conversation' });
  for (let round = 0; round < 4; round++) {
    manager.appendMessage({ role: 'user', content: `history ${round} ` + 'x'.repeat(30000), timestamp: round });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `answer ${round}` }],
      api: 'openai-completions', provider: MODEL_CONFIG.provider, model: MODEL_CONFIG.model, stopReason: 'stop', timestamp: round,
      usage: { input: 786000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 786000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  manager.appendCustomMessageEntry('manao_user_request', 'inspect task attachment', true, { taskId: 'task' });
  const entries = structuredClone(manager.getEntries());
  const backend = {
    readContext: vi.fn(async () => ({ header: manager.getHeader(), headSeq: entries.length,
      entries: entries.map((entry, index) => ({ seq: index + 1, sourceTaskId: 'task', writerId: 'task', entry })), nextAfterSeq: null })),
    appendContext: vi.fn(async (_task: string, batch: { entries: SessionEntry[] }) => {
      entries.push(...structuredClone(batch.entries)); return { headSeq: entries.length };
    }),
    imageCatalog: vi.fn(async () => ({ kind: 'image_catalog', items: [], nextCursor: null })),
    progress: vi.fn(async () => ({ accepted: true })),
  };
  const requests: { compacting: boolean; body: string }[] = [];
  let native!: AgentSession;
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    requests.push({ compacting: native.isCompacting, body: String(init?.body) }); return sse(false);
  });
  const options = { environment: JAVA_ENVIRONMENT, model: { ...MODEL_CONFIG, imageInput: true }, paths: privateDirs(),
    taskId: 'task', conversationId: 'conversation', backend: backend as unknown as BackendClient,
    progress: new ProgressChain(backend as unknown as BackendClient, 'task'),
    deps: { createSession: async (config: Parameters<typeof createAgentSession>[0]) => {
      const made = await createAgentSession(config); native = made.session; return made;
    } } };
  const task = await createPiSession(options);
  try {
    const result = await task.run({ prompt: 'inspect', workspaceRevision: '7', images: [image] });
    expect(result.state, JSON.stringify(result)).toBe('COMPLETED');
    expect(requests.some(request => request.compacting)).toBe(true);
    expect(requests.filter(request => request.compacting).every(request => !request.body.includes(image.data))).toBe(true);
    expect(requests.at(-1)?.body).toContain(image.data);
    expect(entries.some(entry => entry.type === 'compaction')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(image.data);
  } finally { task.dispose(); }
  requests.length = 0;
  const restored = await createPiSession({ ...options, taskId: 'next-task' });
  try {
    expect((await restored.run({ prompt: 'continue', workspaceRevision: '7' })).state).toBe('COMPLETED');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).not.toContain('image_url');
  } finally { restored.dispose(); }
});

it.each(['disabled', 'oversized', 'provider-error', 'stopped'] as const)('settles %s without retaining task image data or projection hooks', async scenario => {
  const image = { type: 'image' as const, mimeType: 'image/png',
    data: scenario === 'oversized' ? 'A'.repeat(48 * 1024 * 1024) : png(1, 1).toString('base64') };
  const backend = { progress: vi.fn(async () => ({ accepted: true })) } as unknown as BackendClient;
  let native!: AgentSession;
  let original: AgentSession['agent']['transformContext'];
  let calls = 0;
  const task = await createPiSession({ environment: JAVA_ENVIRONMENT, model: { ...MODEL_CONFIG, imageInput: scenario !== 'disabled' },
    paths: privateDirs(), taskId: 'task', backend, progress: new ProgressChain(backend, 'task'),
    deps: { settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }), createSession: async options => {
      const made = scriptedSessionFactory([{ errorMessage: 'provider refused request' }], () => calls++)(options);
      native = made.session; original = native.agent.transformContext; return made;
    } } });
  if (scenario === 'stopped') task.stop();
  try {
    const outcome = await task.run({ prompt: 'inspect', workspaceRevision: '7', images: [image] });
    expect(outcome.state).toBe('FAILED');
    expect(outcome.failureCode).toBe({ disabled: 'AI_IMAGE_INPUT_DISABLED', oversized: 'AI_IMAGE_REQUEST_TOO_LARGE',
      'provider-error': 'AI_PROVIDER_ERROR', stopped: 'AI_ABORTED' }[scenario]);
    expect(calls).toBe(scenario === 'provider-error' ? 1 : 0);
    expect(JSON.stringify(native.sessionManager.getEntries())).not.toContain(image.data);
    expect(native.agent.transformContext).toBe(original);
  } finally { task.dispose(); }
});
