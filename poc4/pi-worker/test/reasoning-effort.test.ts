import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ProgressChain, type BackendClient } from "../src/backend-client.js";
import { createPiSession, compactIdleConversation } from "../src/pi-session.js";
import { privateDirs } from "./scripted-session.js";

const conversationId = "00000000-0000-4000-8000-000000000001";
const model = { provider: "deepseek", apiType: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "test-only" };
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const manager = SessionManager.inMemory("manao-project", { id: conversationId });
  const entries: SessionEntry[] = [];
  const payloads: Record<string, unknown>[] = [];
  const invoked: string[] = [];
  const snapshots: { taskId: string; snapshot: any }[] = [];
  let incremental = false;
  let finishReason = "stop";
  let toolNext = false;
  let growNext = false;
  const fixtureFetch: typeof fetch = async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    const tool = toolNext; toolNext = false;
    const grow = growNext; growNext = false;
    const chunk = { choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [{ index: 0, id: "read-one", type: "function", function: { name: "read_file", arguments: '{"path":"demo.txt"}' } }] } : { role: "assistant", content: "ok" }, finish_reason: tool ? "tool_calls" : finishReason }],
      ...(grow ? { usage: { prompt_tokens: 786432, completion_tokens: 1, total_tokens: 786433 } } : {}) };
    if (incremental && !tool) {
      const body = payloads.at(-1)!;
      const deltas = body.reasoning_effort ? [{ reasoning_content: 'first reasoning' }, { reasoning_content: ' second reasoning' }] : [];
      const events = [...deltas, { content: '# Incremental' }, { content: ' answer' }].map(delta => ({ choices: [{ index: 0, delta, finish_reason: null }] }));
      events.push({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] } as typeof events[number]);
      return new Response(new ReadableStream({ async start(controller) {
        for (const event of events) { controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n')); await new Promise(resolve => setTimeout(resolve, 320)); }
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  vi.stubGlobal("fetch", fixtureFetch);
  const page = () => ({ header: manager.getHeader(), headSeq: entries.length, entries: entries.map((entry, i) => ({ seq: i + 1, writerId: "old", sourceTaskId: null, entry })), nextAfterSeq: null });
  const backend = { readContext: async () => page(), readCompactionContext: async () => page(),
    appendContext: async (_task: string, batch: { entries: SessionEntry[] }) => { entries.push(...structuredClone(batch.entries)); return { headSeq: entries.length }; },
    invoke: async (_task: string, request: { toolCallId: string; name: string }) => { invoked.push(request.name); return { toolCallId: request.toolCallId, workspaceRevision: "7", data: { content: "fixture content" }, truncated: false }; },
    liveOutput: async (taskId: string, snapshot: any) => { snapshots.push({ taskId, snapshot: structuredClone(snapshot) }); },
    progress: async () => ({ accepted: true }) } as unknown as BackendClient;
  const paths = privateDirs();
  return { entries, payloads, backend, paths, invoked, snapshots, incremental: () => { incremental = true; }, length: () => { finishReason = "length"; }, tool: () => { toolNext = true; }, grow: () => { growNext = true; } };
}
describe("persisted reasoning effort through the installed Pi SDK", () => {
  it("restores high to off to low to max with read_file, incremental native output and honest length", async () => {
    const f = fixture(); f.incremental(); f.tool();
    for (const effort of ["high", "off", "low", "max"] as const) {
      if (effort === "max") f.length();
      const firstWire = f.payloads.length;
      const task = await createPiSession({ model, paths: f.paths, taskId: effort, conversationId, startRevision: "7", reasoningEffort: effort, backend: f.backend, progress: new ProgressChain(f.backend, effort) });
      try {
        const result = await task.run({ prompt: "read only fixture", workspaceRevision: "7" });
        expect(result).toMatchObject(effort === "max" ? { state: "FAILED", failureCode: "AI_LENGTH_LIMIT" } : { state: "COMPLETED", failureCode: null });
        for (const payload of f.payloads.slice(firstWire)) expect(payload).toMatchObject(effort === "off" ? { stream: true, max_tokens: 8192, thinking: { type: "disabled" } } : { stream: true, max_tokens: 8192, thinking: { type: "enabled" }, reasoning_effort: effort });
        const generating = f.snapshots.filter(row => row.taskId === effort && row.snapshot.current?.phase === "generating").map(row => row.snapshot.current.blocks);
        expect(generating.some(blocks => blocks.some((block: any) => block.kind === "text" && block.text === "# Incremental"))).toBe(true);
        expect(generating.some(blocks => blocks.some((block: any) => block.kind === "text" && block.text === "# Incremental answer"))).toBe(true);
        if (effort !== "off") {
          expect(generating.some(blocks => blocks.some((block: any) => block.kind === "thinking" && block.text === "first reasoning"))).toBe(true);
          expect(generating.some(blocks => blocks.some((block: any) => block.kind === "thinking" && block.text === "first reasoning second reasoning"))).toBe(true);
        }
      } finally { task.dispose(); }
    }
    expect(f.invoked).toEqual(["read_file"]);
    expect(f.entries.filter(entry => entry.type === "thinking_level_change").map(entry => entry.thinkingLevel)).toEqual(["high", "off", "low", "max"]);
  }, 20_000);
  it.each(["off", "low", "high", "max"])("sends %s in the actual DeepSeek request without lowering max", async effort => {
    const f = fixture();
    const task = await createPiSession({ model, paths: f.paths, taskId: "task", reasoningEffort: effort, backend: f.backend, progress: new ProgressChain(f.backend, "task") } as Parameters<typeof createPiSession>[0]);
    try {
      expect((await task.run({ prompt: "hello", workspaceRevision: "7" })).state).toBe("COMPLETED");
      expect(f.payloads.at(-1)).toMatchObject(effort === "off" ? { stream: true, max_tokens: 8192, thinking: { type: "disabled" } } : { stream: true, max_tokens: 8192, thinking: { type: "enabled" }, reasoning_effort: effort });
    } finally { task.dispose(); }
  });
  it("restores high to off to max as native changes, then manually compacts at max", async () => {
    const f = fixture();
    for (const effort of ["high", "off", "max"]) {
      const task = await createPiSession({ model, paths: f.paths, taskId: effort, conversationId, startRevision: "7", reasoningEffort: effort, backend: f.backend, progress: new ProgressChain(f.backend, effort) } as Parameters<typeof createPiSession>[0]);
      try { expect((await task.run({ prompt: "hello", workspaceRevision: "7" })).state).toBe("COMPLETED"); } finally { task.dispose(); }
    }
    expect(f.entries.filter(e => e.type === "thinking_level_change").map(e => e.thinkingLevel)).toEqual(["high", "off", "max"]);
    const restored = SessionManager.inMemory("manao-project", { id: conversationId }, [SessionManager.inMemory("manao-project", { id: conversationId }).getHeader()!, ...f.entries]);
    restored.appendCustomMessageEntry("manao_user_request", "old" + "x".repeat(100_000), true);
    restored.appendCustomMessageEntry("manao_user_request", "recent" + "y".repeat(100_000), true);
    f.entries.splice(0, f.entries.length, ...restored.getEntries());
    const result = await compactIdleConversation({ model, paths: f.paths, backend: f.backend, start: { conversationId, requestId: "compact", expectedHeadSeq: f.entries.length } });
    expect(result.entries.some(e => e.type === "compaction")).toBe(true);
    expect(f.payloads.at(-1)).toMatchObject({ reasoning_effort: "max", max_tokens: 8192 });
  });
  it("preserves length as a failed final response", async () => {
    const f = fixture(); f.length();
    const task = await createPiSession({ model, paths: f.paths, taskId: "task", reasoningEffort: "max", backend: f.backend, progress: new ProgressChain(f.backend, "task") } as Parameters<typeof createPiSession>[0]);
    try { expect(await task.run({ prompt: "hello", workspaceRevision: "7" })).toMatchObject({ state: "FAILED", failureCode: "AI_LENGTH_LIMIT" }); } finally { task.dispose(); }
  });
  it("keeps max for real SDK tool continuation and automatic compaction requests", async () => {
    const f = fixture(); f.tool(); f.grow();
    const seed = SessionManager.inMemory("manao-project", { id: conversationId });
    seed.appendCustomMessageEntry("manao_user_request", "old" + "x".repeat(100_000), true);
    seed.appendCustomMessageEntry("manao_user_request", "recent" + "y".repeat(100_000), true);
    f.entries.push(...seed.getEntries());
    const task = await createPiSession({ model, paths: f.paths, taskId: "task", conversationId, startRevision: "7", reasoningEffort: "max", backend: f.backend, progress: new ProgressChain(f.backend, "task") });
    try {
      expect(await task.run({ prompt: "read file", workspaceRevision: "7" })).toEqual({ state: "COMPLETED", summary: "ok", failureCode: null, reason: "the model finished with a final answer" });
      expect(f.payloads.length).toBeGreaterThanOrEqual(3);
      for (const payload of f.payloads) expect(payload).toMatchObject({ reasoning_effort: "max", max_tokens: 8192, stream: true });
      expect(f.entries.some(entry => entry.type === "compaction")).toBe(true);
      expect(f.payloads.some(payload => JSON.stringify(payload.messages).includes("fixture content"))).toBe(true);
    } finally { task.dispose(); }
  });
  it("rejects a length-limited native summary without advancing a successful compaction", async () => {
    const f = fixture(); f.length();
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    manager.appendThinkingLevelChange("max");
    manager.appendCustomMessageEntry("manao_user_request", "old" + "x".repeat(100_000), true);
    manager.appendCustomMessageEntry("manao_user_request", "recent" + "y".repeat(100_000), true);
    f.entries.push(...manager.getEntries()); const original = structuredClone(f.entries);
    await expect(compactIdleConversation({ model, paths: f.paths, backend: f.backend, start: { conversationId, requestId: "compact", expectedHeadSeq: f.entries.length } })).rejects.toThrow(/token cap|incomplete/);
    expect(f.entries).toEqual(original);
    expect(f.payloads.at(-1)).toMatchObject({ reasoning_effort: "max", max_tokens: 8192 });
  });
});
