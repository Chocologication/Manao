export type LiveBlock = { contentIndex: number; kind: 'thinking' | 'text'; text: string };
export type LiveSnapshot = { revision: number; taskId: string; conversationId: string; durableHeadSeq: number; current: null | { messageOrdinal: number; phase: 'generating' | 'ended'; blocks: LiveBlock[]; modelTruncated: boolean; displayTruncated: boolean }; unavailable: boolean };
export class LiveOutputError extends Error {}
function record(v: unknown): Record<string, unknown> { if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new LiveOutputError('Malformed live output'); return v as Record<string, unknown>; }
function integer(v: unknown): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new LiveOutputError('Invalid live index'); return v; }
function text(v: unknown): string { if (typeof v !== 'string') throw new LiveOutputError('Invalid live text'); return v; }
function bool(v: unknown): boolean { if (typeof v !== 'boolean') throw new LiveOutputError('Invalid live flag'); return v; }
export function parseLiveSnapshot(value: unknown): LiveSnapshot {
  const v = record(value); let current: LiveSnapshot['current'] = null;
  if (v.current !== null) {
    const c = record(v.current);
    if (!Array.isArray(c.blocks) || c.phase !== 'generating' && c.phase !== 'ended') throw new LiveOutputError('Invalid live message');
    const indices = new Set<number>();
    const blocks = c.blocks.map(value => {
      const b = record(value); const contentIndex = integer(b.contentIndex);
      if (b.kind !== 'thinking' && b.kind !== 'text' || indices.has(contentIndex)) throw new LiveOutputError('Invalid live block');
      indices.add(contentIndex); return { contentIndex, kind: b.kind, text: text(b.text) } as LiveBlock;
    });
    current = { messageOrdinal: integer(c.messageOrdinal), phase: c.phase, blocks, modelTruncated: bool(c.modelTruncated), displayTruncated: bool(c.displayTruncated) };
  }
  return { revision: integer(v.revision), taskId: text(v.taskId), conversationId: text(v.conversationId), durableHeadSeq: integer(v.durableHeadSeq), current, unavailable: bool(v.unavailable) };
}

// One bounded SSE frame; complete snapshots replace each other, never a delta log.
export async function consumeLiveOutput(response: Response, publish: (snapshot: LiveSnapshot) => void, signal?: AbortSignal): Promise<void> {
  if (!response.body) throw new LiveOutputError('Missing live stream');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
  let line = '', event = '', data: string[] = [], frameBytes = 0, previousCR = false;
  const finishLine = () => {
    if (line === '') {
      if (event === 'snapshot' && data.length) {
        const json = data.join('\n');
        if (encoder.encode(json).length > 256 * 1024) throw new LiveOutputError('Live JSON too large');
        let payload: unknown; try { payload = JSON.parse(json); } catch { throw new LiveOutputError('Invalid live JSON'); }
        if (!signal?.aborted) publish(parseLiveSnapshot(payload));
      }
      event = ''; data = []; frameBytes = 0;
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
    }
    line = '';
  };
  const consume = (chunk: string) => {
    for (const char of chunk) {
      if (previousCR) {
        previousCR = false;
        if (char === '\n') { if (++frameBytes > 260 * 1024) throw new LiveOutputError('Live frame too large'); finishLine(); continue; }
        finishLine();
      }
      frameBytes += encoder.encode(char).length;
      if (frameBytes > 260 * 1024) throw new LiveOutputError('Live frame too large');
      if (char === '\r') previousCR = true; else if (char === '\n') finishLine(); else line += char;
    }
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const decode = (bytes?: Uint8Array) => { try { return bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode(); } catch { throw new LiveOutputError('Invalid live UTF8'); } };
    while (!signal?.aborted) { const chunk = await reader.read(); if (chunk.done) break; consume(decode(chunk.value)); }
    if (!signal?.aborted) { consume(decode()); if (previousCR) finishLine(); }
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
