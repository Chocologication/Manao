import { expect, it, vi } from 'vitest';
import { consumeLiveOutput, parseLiveSnapshot, type LiveSnapshot } from './agentLiveOutput';
const encoder = new TextEncoder();
it('counts both bytes of CRLF toward the physical frame bound', async () => { const wire = ':x\r\n'.repeat(70000); await expect(consumeLiveOutput(response(encoder.encode(wire)), vi.fn())).rejects.toThrow('frame'); });
it('keeps a network reader failure retryable rather than classifying it as malformed UTF8', async () => { const failure = new TypeError('network reset'); const stream = new ReadableStream({ start(c) { c.error(failure); } }); await expect(consumeLiveOutput(new Response(stream), vi.fn())).rejects.toBe(failure); });
const snapshot: LiveSnapshot = { revision: 3, taskId: 't', conversationId: 'c', durableHeadSeq: 5, current: { messageOrdinal: 1, phase: 'generating', blocks: [{ contentIndex: 0, kind: 'thinking', text: '思考中文🙂' }], modelTruncated: false, displayTruncated: false }, unavailable: false };
function response(bytes: Uint8Array, cuts: number[] = []) { let start = 0; return new Response(new ReadableStream({ start(controller) { for (const end of [...cuts, bytes.length]) { controller.enqueue(bytes.slice(start, end)); start = end; } controller.close(); } })); }
it('decodes split UTF8 and CRLF exactly once, joins data lines and ignores comments and unknown events', async () => {
  const json = JSON.stringify(snapshot); const wire = [': heartbeat', 'event: ignored', 'data: invalid', '', 'event: snapshot', 'data: ' + json.slice(0, 1), 'data: ' + json.slice(1), '', ''].join(String.fromCharCode(13, 10));
  const bytes = encoder.encode(wire); const decodedSnapshots: LiveSnapshot[] = [];
  await consumeLiveOutput(response(bytes, Array.from({ length: bytes.length - 1 }, (_, i) => i + 1)), s => decodedSnapshots.push(s));
  expect(decodedSnapshots).toEqual([snapshot]); expect(decodedSnapshots[0]!.current?.blocks[0]!.text).toBe('思考中文🙂');
});
it('publishes multiple complete frames but never an unterminated frame', async () => {
  const wire = `event: snapshot
data: ${JSON.stringify(snapshot)}

`; const publish = vi.fn();
  await consumeLiveOutput(response(encoder.encode(wire + wire + wire.trimEnd())), publish); expect(publish).toHaveBeenCalledTimes(2);
});
it('accepts exactly 256KiB JSON plus framing and rejects one extra JSON byte', async () => {
  const base = JSON.parse(JSON.stringify(snapshot)) as LiveSnapshot; base.current!.blocks[0]!.text = '';
  base.current!.blocks[0]!.text = 'x'.repeat(256 * 1024 - encoder.encode(JSON.stringify(base)).length);
  const publish = vi.fn(); await consumeLiveOutput(response(encoder.encode(`event: snapshot
data: ${JSON.stringify(base)}

`)), publish); expect(publish).toHaveBeenCalledTimes(1);
  base.current!.blocks[0]!.text += 'x'; await expect(consumeLiveOutput(response(encoder.encode(`event: snapshot
data: ${JSON.stringify(base)}

`)), publish)).rejects.toThrow();
});
it.each([':'.repeat(260 * 1024 + 1), 'data: ' + '中'.repeat(100000)])('bounds unfinished frames including comments by UTF8 bytes', async wire => { await expect(consumeLiveOutput(response(encoder.encode(wire)), vi.fn())).rejects.toThrow(); });
it.each([{ revision: -1 }, { durableHeadSeq: NaN }, { unavailable: 'no' }, { current: { ...snapshot.current, phase: 'bad' } }, { current: { ...snapshot.current, blocks: [{ contentIndex: 0.5, kind: 'text', text: '' }] } }])('rejects malformed snapshot fields %j', patch => { expect(() => parseLiveSnapshot({ ...snapshot, ...patch })).toThrow(); });
it('validates the real snapshot without mutating its input', () => { expect(parseLiveSnapshot(snapshot)).toEqual(snapshot); });
it('cancels and releases the reader on malformed payload', async () => { const cancel = vi.fn(); const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode(['event: snapshot', 'data: bad', '', ''].join(String.fromCharCode(10)))); }, cancel }); await expect(consumeLiveOutput(new Response(body), vi.fn())).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false); });
