import { describe, expect, it, vi } from 'vitest';
import { consumeEvents, saveModel } from './api';
import { HttpClient, setHttpClient } from '@/api/httpClient';
import type { Turn } from './types';

const turn: Turn = { id: 'turn', conversationId: 'conversation', mode: 'CHAT', applyPolicy: 'REVIEW', modelId: 'model', expectedRevision: '7',
  createdAt: new Date().toISOString(), version: 2, state: 'RUNNING', prompt: '你好', reply: '中文分片🙂', tools: [], files: [], references: [], attachmentIds: [] };
function response(parts: Uint8Array[]) { return new Response(new ReadableStream({ start(c) { parts.forEach(p => c.enqueue(p)); c.close(); } })); }

it('editing a saved model omits response-only fields from strict request JSON', async () => {
  const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  setHttpClient(new HttpClient({ getAccessToken: () => null, onUnauthorized: vi.fn(), fetchImpl }));
  try {
    await saveModel({ ...{ id: 'model', label: 'Saved', baseUrl: 'https://example.com/v1', model: 'example',
      vision: false, tools: true, keyConfigured: true }, apiKey: '' });
    const request = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).not.toHaveProperty('keyConfigured');
    expect(JSON.parse(String(request[1].body))).toMatchObject({ id: 'model', apiKey: '' });
  } finally { setHttpClient(null); }
});
describe('assistant SSE network boundaries', () => {
  it('handles UTF-8 and CRLF split at every byte and ignores heartbeat frames', async () => {
    const bytes = new TextEncoder().encode(`: heartbeat\r\n\r\nevent: snapshot\r\ndata: ${JSON.stringify(turn)}\r\n\r\n`);
    const publish = vi.fn();
    await consumeEvents(response(Array.from(bytes, byte => new Uint8Array([byte]))), publish, new AbortController().signal);
    expect(publish).toHaveBeenCalledExactlyOnceWith(turn);
  });
  it('propagates revoked authentication before another snapshot', async () => {
    const publish = vi.fn();
    await expect(consumeEvents(response([new TextEncoder().encode('event: auth.revoked\ndata: {}\n\n')]), publish, new AbortController().signal)).rejects.toThrow('AUTH_REVOKED');
    expect(publish).not.toHaveBeenCalled();
  });
  it('refuses malformed snapshots and oversized unterminated frames', async () => {
    await expect(consumeEvents(response([new TextEncoder().encode('event: snapshot\ndata: {}\n\n')]), vi.fn(), new AbortController().signal)).rejects.toThrow();
    await expect(consumeEvents(response([new Uint8Array(4 * 1024 * 1024 + 1).fill(97)]), vi.fn(), new AbortController().signal)).rejects.toThrow('limit');
  });
  it('aborts an idle reader without publishing or waiting for network data', async () => {
    const controller = new AbortController(), cancel = vi.fn(), publish = vi.fn();
    const consuming = consumeEvents(new Response(new ReadableStream({ cancel })), publish, controller.signal);
    controller.abort(); await consuming; expect(cancel).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled();
  });
});
