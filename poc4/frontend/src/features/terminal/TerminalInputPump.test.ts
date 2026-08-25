import { describe, expect, it } from 'vitest';
import {
  TERMINAL_INPUT_BUFFER_HIGH_WATERMARK_BYTES,
  TERMINAL_INPUT_BUFFER_LOW_WATERMARK_BYTES,
  TERMINAL_INPUT_FRAME_BYTES,
  TERMINAL_INPUT_QUEUE_CAP_BYTES,
  TerminalInputPump,
  encodeTerminalBinary,
  encodeTerminalData,
  type TerminalInputPumpScheduler,
} from './TerminalInputPump';

class FakeInputSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];

  send(data: ArrayBuffer): void {
    this.sent.push(new Uint8Array(data.slice(0)));
  }
}

function createScheduler() {
  let nextId = 1;
  const tasks = new Map<number, { handler: () => void; delayMs: number }>();
  const requestedDelays: number[] = [];
  const scheduler: TerminalInputPumpScheduler = {
    setTimeout(handler, delayMs) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { handler, delayMs });
      requestedDelays.push(delayMs);
      return id;
    },
    clearTimeout(id) {
      tasks.delete(Number(id));
    },
  };
  return {
    scheduler,
    pendingCount: () => tasks.size,
    pendingDelays: () => [...tasks.values()].map((task) => task.delayMs),
    requestedDelays: () => [...requestedDelays],
    runNext() {
      const next = tasks.entries().next().value as [
        number,
        { handler: () => void; delayMs: number },
      ] | undefined;
      if (next === undefined) return;
      tasks.delete(next[0]);
      next[1].handler();
    },
  };
}

describe('terminal input byte conversion', () => {
  it('encodes onData Unicode as exact UTF-8 without losing control bytes', () => {
    expect([...encodeTerminalData('A\u0000\u001b\u4e2d\ud83d\ude00')]).toEqual([
      0x41,
      0x00,
      0x1b,
      0xe4,
      0xb8,
      0xad,
      0xf0,
      0x9f,
      0x98,
      0x80,
    ]);
  });

  it('maps every onBinary code unit to its low eight bits exactly once', () => {
    const binary = String.fromCharCode(0x0000, 0x001b, 0x00ff, 0x1234, 0xd83d, 0xde00);

    expect([...encodeTerminalBinary(binary)]).toEqual([0x00, 0x1b, 0xff, 0x34, 0x3d, 0x00]);
  });
});

describe('TerminalInputPump', () => {
  it('sends a large paste as exact ordered 16 KiB frames without double encoding', () => {
    const socket = new FakeInputSocket();
    const pump = new TerminalInputPump({ socket });
    const paste = `${'\u4e2d'.repeat(6_000)}\u0000\u001b`;
    const binary = String.fromCharCode(0xff, 0x1234);

    expect(pump.enqueueData(paste)).toBe(true);
    expect(pump.enqueueBinary(binary)).toBe(true);

    const expected = [...new TextEncoder().encode(paste), 0xff, 0x34];
    expect(socket.sent.map((frame) => frame.byteLength)).toEqual([
      TERMINAL_INPUT_FRAME_BYTES,
      expected.length - TERMINAL_INPUT_FRAME_BYTES - 2,
      2,
    ]);
    expect(socket.sent.flatMap((frame) => [...frame])).toEqual(expected);
  });

  it('holds buffered input at the high watermark and resumes only below the low watermark', () => {
    const socket = new FakeInputSocket();
    const clock = createScheduler();
    const pauses: boolean[] = [];
    socket.bufferedAmount = TERMINAL_INPUT_BUFFER_HIGH_WATERMARK_BYTES;
    const pump = new TerminalInputPump({
      socket,
      scheduler: clock.scheduler,
      onPauseChange: (paused) => pauses.push(paused),
    });

    pump.enqueueData('queued');
    expect(socket.sent).toEqual([]);
    expect(pauses).toEqual([true]);
    expect(clock.pendingCount()).toBe(1);
    expect(clock.pendingDelays()).toEqual([50]);
    expect(clock.requestedDelays()).toEqual([50]);

    socket.bufferedAmount = TERMINAL_INPUT_BUFFER_LOW_WATERMARK_BYTES;
    clock.runNext();
    expect(socket.sent).toEqual([]);
    expect(clock.pendingCount()).toBe(1);
    expect(clock.pendingDelays()).toEqual([50]);
    expect(clock.requestedDelays()).toEqual([50, 50]);

    socket.bufferedAmount = TERMINAL_INPUT_BUFFER_LOW_WATERMARK_BYTES - 1;
    clock.runNext();
    expect(socket.sent.map((frame) => [...frame])).toEqual([[...new TextEncoder().encode('queued')]]);
    expect(pauses).toEqual([true, false]);
    expect(clock.pendingCount()).toBe(0);
  });

  it('stops draining while the server is paused and resumes the same FIFO', () => {
    const socket = new FakeInputSocket();
    const clock = createScheduler();
    const pauses: boolean[] = [];
    const pump = new TerminalInputPump({
      socket,
      scheduler: clock.scheduler,
      onPauseChange: (paused) => pauses.push(paused),
    });

    pump.setServerPaused(true);
    pump.enqueueBinary(String.fromCharCode(0x00, 0xff, 0x1b));
    expect(socket.sent).toEqual([]);
    expect(pauses).toEqual([true]);

    socket.bufferedAmount = TERMINAL_INPUT_BUFFER_LOW_WATERMARK_BYTES;
    pump.setServerPaused(false);
    expect(socket.sent).toEqual([]);
    expect(clock.pendingCount()).toBe(1);
    expect(clock.pendingDelays()).toEqual([50]);
    expect(clock.requestedDelays()).toEqual([50]);

    clock.runNext();
    expect(socket.sent).toEqual([]);
    expect(clock.pendingDelays()).toEqual([50]);
    expect(clock.requestedDelays()).toEqual([50, 50]);

    socket.bufferedAmount = TERMINAL_INPUT_BUFFER_LOW_WATERMARK_BYTES - 1;
    clock.runNext();
    expect(socket.sent.map((frame) => [...frame])).toEqual([[0x00, 0xff, 0x1b]]);
    expect(pauses).toEqual([true, false]);
  });

  it('fails closed instead of partially accepting input beyond the 1 MiB FIFO cap', () => {
    const socket = new FakeInputSocket();
    const clock = createScheduler();
    const overflows: number[] = [];
    socket.bufferedAmount = TERMINAL_INPUT_BUFFER_HIGH_WATERMARK_BYTES;
    const pump = new TerminalInputPump({
      socket,
      scheduler: clock.scheduler,
      onOverflow: (attemptedBytes) => overflows.push(attemptedBytes),
    });

    expect(pump.enqueueData('a'.repeat(TERMINAL_INPUT_QUEUE_CAP_BYTES))).toBe(true);
    expect(pump.queuedByteLength).toBe(TERMINAL_INPUT_QUEUE_CAP_BYTES);
    expect(pump.enqueueData('b')).toBe(false);

    expect(overflows).toEqual([TERMINAL_INPUT_QUEUE_CAP_BYTES + 1]);
    expect(pump.queuedByteLength).toBe(0);
    expect(clock.pendingCount()).toBe(0);
    expect(socket.sent).toEqual([]);
  });

  it('never sends outside OPEN and dispose clears queued bytes and scheduled drains', () => {
    const socket = new FakeInputSocket();
    const clock = createScheduler();
    socket.readyState = 0;
    const pump = new TerminalInputPump({ socket, scheduler: clock.scheduler });

    expect(pump.enqueueData('pending')).toBe(true);
    expect(socket.sent).toEqual([]);
    expect(clock.pendingCount()).toBe(1);

    pump.dispose();
    expect(pump.queuedByteLength).toBe(0);
    expect(clock.pendingCount()).toBe(0);
    socket.readyState = 1;
    clock.runNext();
    expect(socket.sent).toEqual([]);
    expect(pump.enqueueData('late')).toBe(false);
  });
});
