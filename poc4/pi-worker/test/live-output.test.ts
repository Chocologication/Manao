import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ProgressChain, type BackendClient } from "../src/backend-client.js";
import { createPiSession } from "../src/pi-session.js";
import { MODEL_CONFIG, privateDirs, scriptedSessionFactory } from "./scripted-session.js";

const conversationId = "00000000-0000-4000-8000-000000000001";

describe("live output native ACK boundary", () => {
  it("keeps the ended native assistant until its original entry is acknowledged", async () => {
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    const entries = structuredClone(manager.getEntries());
    const snapshots: any[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let originalHead = -1;
    const backend = {
      readContext: async () => ({ header: manager.getHeader(), headSeq: entries.length, entries: [], nextAfterSeq: null }),
      appendContext: async (_task: string, batch: any) => {
        if (batch.entries.some((entry: any) => entry.type === "message" && entry.message.role === "assistant")) {
          originalHead = batch.expectedHeadSeq;
          await held;
        }
        entries.push(...structuredClone(batch.entries));
        return { headSeq: entries.length };
      },
      liveOutput: async (_task: string, snapshot: any) => { snapshots.push(structuredClone(snapshot)); },
      progress: async () => ({ accepted: true }),
    } as unknown as BackendClient;
    const pi = await createPiSession({ model: MODEL_CONFIG, paths: privateDirs(), taskId: "native-ack", conversationId,
      backend, progress: new ProgressChain(backend, "native-ack"), deps: { createSession: async (options) => scriptedSessionFactory([{ text: "保存前的正文" }])(options) } });
    try {
      const run = pi.run({ prompt: "继续", workspaceRevision: "7" });
      await vi.waitFor(() => expect(originalHead).toBeGreaterThanOrEqual(0));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const sentBeforeAck = snapshots.at(-1);
      expect(sentBeforeAck?.current?.phase).toBe("ended");
      expect(sentBeforeAck.durableHeadSeq).toBe(originalHead);
      release();
      expect((await run).state).toBe("COMPLETED");
      await vi.waitFor(() => expect(snapshots.at(-1)?.current).toBeNull());
      const sentAfterAck = snapshots.at(-1);
      expect(sentAfterAck.durableHeadSeq).toBe(entries.length);
    } finally { release(); pi.dispose(); }
  });
});

// A real Pi session/loop with only its provider stream and external HTTP boundary controlled.
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { BackendClient as HttpBackendClient } from "../src/backend-client.js";
import { LiveOutput, type LiveSnapshot } from "../src/live-output.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach } from "vitest";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function message(content: AssistantMessage["content"] = [], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: "openai-completions", provider: "manao-test", model: "scripted-1", usage, stopReason, timestamp: Date.now() };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function liveFixture(provider: (stream: AssistantMessageEventStream, round: number) => void, hooks: {
  append?: (batch: any) => Promise<void>; live?: (init: RequestInit) => Promise<void>; conversation?: boolean;
} = {}) {
  const manager = SessionManager.inMemory("manao-project", { id: conversationId });
  const entries: any[] = [];
  const sent: LiveSnapshot[] = [];
  const events: AgentSessionEvent[] = [];
  const terminal: any[] = [];
  const invoked: string[] = [];
  const backend = new HttpBackendClient({ baseUrl: "http://fixture", token: "private-test", instanceId: "test-worker", epoch: 4,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.pathname.endsWith("/live-output")) { sent.push(body); await hooks.live?.(init!); return new Response(null, { status: 204 }); }
      if (url.pathname.endsWith("/context")) {
        if (init?.method === "GET") return Response.json({ header: manager.getHeader(), headSeq: 0, entries: [], nextAfterSeq: null });
        await hooks.append?.(body);
        entries.push(...body.entries);
        return Response.json({ headSeq: entries.length });
      }
      if (url.pathname.includes("/calls/")) { invoked.push(body.name); return Response.json({ toolCallId: body.toolCallId, workspaceRevision: "7", data: { content: "file contents" }, truncated: false }); }
      if (url.pathname.endsWith("/progress")) { if (body.kind === "terminal") terminal.push(JSON.parse(body.text)); return Response.json({ accepted: true }); }
      throw new Error(`Unexpected fixture request ${url.pathname}`);
    } });
  let round = 0;
  const pi = await createPiSession({ model: MODEL_CONFIG, paths: privateDirs(), taskId: "live-fixture",
    ...(hooks.conversation === false ? {} : { conversationId }), backend, progress: new ProgressChain(backend, "live-fixture"),
    deps: { createSession: async (options) => {
      const { session } = scriptedSessionFactory([])(options);
      session.subscribe((event) => events.push(event));
      session.agent.streamFunction = () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => provider(stream, ++round));
        return stream;
      };
      return { session };
    } } });
  return { pi, sent, entries, events, terminal, invoked };
}
function textStream(stream: AssistantMessageEventStream, text: string, tool = false): AssistantMessage {
  const partial = message([], "pending");
  stream.push({ type: "start", partial });
  partial.content.push({ type: "thinking", thinking: "推理行一\n推理行二", thinkingSignature: "private-signature" });
  stream.push({ type: "thinking_start", contentIndex: 0, partial });
  stream.push({ type: "thinking_delta", contentIndex: 0, delta: "推理行一\n推理行二", partial });
  stream.push({ type: "thinking_end", contentIndex: 0, content: "推理行一\n推理行二", partial });
  partial.content.push({ type: "text", text });
  stream.push({ type: "text_start", contentIndex: 1, partial });
  stream.push({ type: "text_delta", contentIndex: 1, delta: text, partial });
  if (tool) {
    const toolCall = { type: "toolCall" as const, id: "native-read", name: "read_file", arguments: { path: "pom.xml" } };
    partial.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex: 2, partial });
    stream.push({ type: "toolcall_end", contentIndex: 2, toolCall, partial });
  }
  return partial;
}
afterEach(() => vi.useRealTimers());

describe("real Pi live-output integration", () => {
  it("shows reasoning and answer before message_end and settles the outcome while a live POST stays stalled", async () => {
    let stream!: AssistantMessageEventStream;
    let partial!: AssistantMessage;
    const post = deferred();
    let livePostSettled = false;
    const fixture = await liveFixture((value, round) => {
      if (round === 1) { stream = value; partial = textStream(stream, "第一段正文", true); }
      else { const done = message([{ type: "text", text: "工具续轮完成" }]); value.push({ type: "done", reason: "stop", message: done }); }
    }, { live: () => post.promise.then(() => { livePostSettled = true; }) });
    try {
      const run = fixture.pi.run({ prompt: "继续", workspaceRevision: "7" });
      await vi.waitFor(() => expect(fixture.events.some((event) => event.type === "message_update")).toBe(true));
      await vi.waitFor(() => expect(fixture.sent.some((snapshot) => snapshot.current?.phase === "generating")).toBe(true));
      const generating = fixture.sent.find((snapshot) => snapshot.current?.phase === "generating")!;
      expect(generating.current?.blocks).toEqual([
        { contentIndex: 0, kind: "thinking", text: "推理行一\n推理行二" },
        { contentIndex: 1, kind: "text", text: "第一段正文" },
      ]);
      expect(JSON.stringify(generating)).not.toContain("private-signature");
      stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } });
      const outcome = await run;
      // The stalled live display POST never blocked the execution loop: the outcome is
      // frozen and ready for the delivery layer, and the session itself sent no
      // terminal through the progress chain.
      const runSettledWhileLivePostStalled = !livePostSettled;
      expect(runSettledWhileLivePostStalled).toBe(true);
      expect(fixture.terminal).toEqual([]);
      expect(outcome).toMatchObject({ state: "COMPLETED", summary: "工具续轮完成" });
      expect(fixture.invoked).toEqual(["read_file"]);
      expect(generating.current?.phase).toBe("generating");
      expect(generating.current?.blocks[1]?.text).toBe("第一段正文");
    } finally { post.resolve(); fixture.pi.dispose(); }
  });

  it("preserves the old ended draft when failed persistence creates a synthetic error assistant", async () => {
    const fixture = await liveFixture((stream) => {
      const partial = textStream(stream, "不可覆盖的草稿", true);
      stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } });
    }, { append: async (batch) => { if (batch.entries.some((entry: any) => entry.message?.role === "assistant")) throw new Error("save failed"); } });
    try {
      const outcome = await fixture.pi.run({ prompt: "继续", workspaceRevision: "7" });
      await vi.waitFor(() => expect(fixture.sent.at(-1)?.unavailable).toBe(true));
      expect(outcome.failureCode).toBe("AI_CONTEXT_UNAVAILABLE");
      expect(fixture.events.filter((event) => event.type === "message_start" && event.message.role === "assistant").length).toBeGreaterThan(1);
      expect(fixture.sent.at(-1)?.current).toMatchObject({ phase: "ended", messageOrdinal: 1, blocks: [
        { contentIndex: 0, kind: "thinking", text: "推理行一\n推理行二" },
        { contentIndex: 1, kind: "text", text: "不可覆盖的草稿" },
      ] });
      expect(fixture.invoked).toEqual([]);
    } finally { fixture.pi.dispose(); }
  });

  it("does not create a live protocol for legacy task-only sessions", async () => {
    const fixture = await liveFixture((stream) => stream.push({ type: "done", reason: "stop", message: message([{ type: "text", text: "legacy answer" }]) }), { conversation: false });
    try { expect((await fixture.pi.run({ prompt: "继续", workspaceRevision: "7" })).summary).toBe("legacy answer"); expect(fixture.sent).toEqual([]); }
    finally { fixture.pi.dispose(); }
  });
});

describe("live snapshot publisher bounds", () => {
  it("limits escaped JSON bytes with complete Unicode while reserving answer space separately from long thinking", async () => {
    const held = deferred();
    const thinking = '"\\\n😀'.repeat(40_000);
    const answer = "😀".repeat(40_000);
    const fixture = await liveFixture((stream) => {
      const result = message([{ type: "thinking", thinking }, { type: "text", text: answer }], "length");
      stream.push({ type: "start", partial: message([], "pending") });
      stream.push({ type: "done", reason: "length", message: result });
    }, { append: async (batch) => { if (batch.entries.some((entry: any) => entry.message?.role === "assistant")) await held.promise; } });
    try {
      const run = fixture.pi.run({ prompt: "继续", workspaceRevision: "7" });
      await vi.waitFor(() => expect(fixture.sent.at(-1)?.current?.phase).toBe("ended"));
      const preview = fixture.sent.at(-1)!;
      expect(Buffer.byteLength(JSON.stringify(preview), "utf8")).toBeLessThanOrEqual(256 * 1024);
      expect(preview.current).toMatchObject({ modelTruncated: true, displayTruncated: true });
      const visibleAnswer = preview.current!.blocks.find((block) => block.kind === "text")!.text;
      expect(Buffer.byteLength(visibleAnswer, "utf8")).toBeGreaterThanOrEqual(32 * 1024);
      expect(answer.startsWith(visibleAnswer)).toBe(true);
      for (const block of preview.current!.blocks) expect(block.text.isWellFormed()).toBe(true);
      held.resolve();
      expect((await run).failureCode).toBe("AI_LENGTH_LIMIT");
      expect(fixture.entries.find((entry) => entry.message?.stopReason === "length").message.content[0].thinking).toBe(thinking);
    } finally { held.resolve(); fixture.pi.dispose(); }
  });

  it("coalesces updates with immutable inflight and latest snapshots and replays identical revisions on pulse", async () => {
    vi.useFakeTimers();
    const posts: { snapshot: LiveSnapshot; resolve: () => void }[] = [];
    const backend = { liveOutput: (_task: string, snapshot: LiveSnapshot) => new Promise<void>((resolve) => posts.push({ snapshot, resolve })) } as BackendClient;
    const live = new LiveOutput(backend, "task", conversationId, 3);
    const native = message();
    live.observe({ type: "message_start", message: native });
    const update = (text: string) => live.observe({ type: "message_update", message: native, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: native } });
    try {
      update("a");
      await vi.advanceTimersByTimeAsync(249);
      expect(posts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(posts).toHaveLength(1);
      const original = JSON.stringify(posts[0]!.snapshot);
      update("b"); update("c");
      await vi.advanceTimersByTimeAsync(250);
      expect(posts).toHaveLength(1);
      expect(JSON.stringify(posts[0]!.snapshot)).toBe(original);
      posts[0]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(posts).toHaveLength(2);
      expect(posts[1]!.snapshot.current!.blocks[0]!.text).toBe("abc");
      expect(posts[1]!.snapshot.revision).toBeGreaterThan(posts[0]!.snapshot.revision + 1);
      posts[1]!.resolve();
      await vi.advanceTimersByTimeAsync(1500);
      expect(posts).toHaveLength(3);
      expect(posts[2]!.snapshot).toEqual(posts[1]!.snapshot);
      native.content = [{ type: "text", text: "abc" }];
      live.observe({ type: "message_end", message: native });
      posts[2]!.resolve();
      await vi.advanceTimersByTimeAsync(250);
      expect(posts.at(-1)!.snapshot.current?.phase).toBe("ended");
      expect(posts.at(-1)!.snapshot.revision).toBeGreaterThan(posts[1]!.snapshot.revision);
      const ended = posts.at(-1)!.snapshot;
      posts.at(-1)!.resolve();
      await vi.advanceTimersByTimeAsync(1750);
      expect(posts.at(-1)!.snapshot).toEqual(ended);
      live.checkpoint([], 3);
      posts.at(-1)!.resolve();
      await vi.advanceTimersByTimeAsync(250);
      expect(posts.at(-1)!.snapshot).toEqual(ended);
    } finally { live.dispose(); for (const post of posts) post.resolve(); }
  });

  it("cancels stalled display requests at two seconds and dispose cancels all later pulses", async () => {
    vi.useFakeTimers();
    const requests: RequestInit[] = [];
    const backend = new HttpBackendClient({ baseUrl: "http://fixture", token: "token", instanceId: "worker", epoch: 9, fetch: async (_url, init) => { requests.push(init!); return await new Promise<Response>(() => {}); } });
    const live = new LiveOutput(backend, "task", conversationId, 0);
    live.observe({ type: "message_start", message: message() });
    await vi.advanceTimersByTimeAsync(250);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(requests[0]!.signal!.aborted).toBe(true);
    expect(requests).toHaveLength(2);
    live.dispose();
    expect(requests[1]!.signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(requests).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("final live delivery", () => {
  it("cancels the obsolete inflight request and submits latest before its own bounded cleanup", async () => {
    vi.useFakeTimers();
    const posts: Array<{ body: LiveSnapshot; signal: AbortSignal }> = [];
    const backend = new HttpBackendClient({ baseUrl: "http://fixture", token: "token", instanceId: "worker", epoch: 9, fetch: async (_url, init) => {
      posts.push({ body: JSON.parse(String(init!.body)), signal: init!.signal! });
      return new Promise<Response>(() => {});
    } });
    const live = new LiveOutput(backend, "task", conversationId, 0);
    live.observe({ type: "message_start", message: message() });
    await vi.advanceTimersByTimeAsync(250);
    live.checkpoint([], 4);
    live.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts[0]!.signal.aborted).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body.durableHeadSeq).toBe(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(posts[1]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    live.dispose();
  });
});

it("keeps a truncated live block as a true prefix when later smaller deltas arrive", async () => {
  vi.useFakeTimers();
  const sent: LiveSnapshot[] = [];
  const live = new LiveOutput({ liveOutput: async (_task: string, snapshot: LiveSnapshot) => { sent.push(snapshot); } } as BackendClient, "task", conversationId, 0);
  const native = message();
  const update = (delta: string) => live.observe({ type: "message_update", message: native, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: native } });
  try {
    live.observe({ type: "message_start", message: native });
    const original = "😀".repeat(100_000);
    update(original);
    await vi.advanceTimersByTimeAsync(250);
    update("a");
    await vi.advanceTimersByTimeAsync(250);
    expect((original + "a").startsWith(sent.at(-1)!.current!.blocks[0]!.text)).toBe(true);
  } finally { live.dispose(); }
});

it("keeps a later block prefix after earlier block growth passively clips it", async () => {
  vi.useFakeTimers();
  const sent: LiveSnapshot[] = [];
  const live = new LiveOutput({ liveOutput: async (_task: string, snapshot: LiveSnapshot) => { sent.push(snapshot); } } as BackendClient, "task", conversationId, 0);
  const native = message();
  const update = (contentIndex: number, delta: string) => live.observe({ type: "message_update", message: native, assistantMessageEvent: { type: "text_delta", contentIndex, delta, partial: native } });
  try {
    live.observe({ type: "message_start", message: native });
    const original = "😀".repeat(32_700);
    update(0, "a");
    update(1, original);
    await vi.advanceTimersByTimeAsync(250);
    expect(sent.at(-1)!.current!.blocks[1]!.text).toBe(original);
    expect(sent.at(-1)!.current!.displayTruncated).toBe(false);
    const initial = sent.at(-1)!;
    update(0, "b".repeat(200));
    await vi.advanceTimersByTimeAsync(250);
    const clipped = sent.at(-1)!;
    const clippedText = clipped.current!.blocks[1]!.text;
    expect(clippedText.length).toBeLessThan(original.length);
    expect(original.startsWith(clippedText)).toBe(true);
    expect(clipped.current).toMatchObject({ displayTruncated: true, modelTruncated: false });
    expect(clipped.revision).toBeGreaterThan(initial.revision);
    expect(initial.current!.blocks[1]!.text).toBe(original);
    update(1, "z");
    await vi.advanceTimersByTimeAsync(250);
    const after = sent.at(-1)!;
    expect((original + "z").startsWith(after.current!.blocks[1]!.text)).toBe(true);
    expect(after.current!.blocks[1]!.text).toBe(clippedText);
    expect(after.revision).toBe(clipped.revision);
    expect(Buffer.byteLength(JSON.stringify(after), "utf8")).toBeLessThanOrEqual(256 * 1024);
  } finally { live.dispose(); }
});
