import { describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { BackendHttpError, ProgressChain, type BackendClient } from "../src/backend-client.js";
import { createPiSession } from "../src/pi-session.js";
import { MODEL_CONFIG, privateDirs, scriptedSessionFactory, type ScriptedResponse } from "./scripted-session.js";

const conversationId = "00000000-0000-4000-8000-000000000001";
function history() {
  const manager = SessionManager.inMemory("manao-project", { id: conversationId });
  manager.appendCustomMessageEntry("manao_user_request", "旧目标：字段必须保留 bookId。" + "中文".repeat(5000), true, { taskId: "old-task" });
  return manager;
}
function backendFor(manager: SessionManager) {
  const entries = structuredClone(manager.getEntries());
  const progressItems: Array<{ kind: string; text: string }> = [];
  const backend = {
    readContext: vi.fn(async (_task: string, after = 0, through?: number) => ({ header: manager.getHeader(), headSeq: through ?? entries.length,
      entries: entries.slice(after, through ?? entries.length).map((entry, index) => ({ seq: after + index + 1, sourceTaskId: null, writerId: "task", entry })), nextAfterSeq: null })),
    appendContext: vi.fn(async (_task: string, batch: { expectedHeadSeq: number; entries: SessionEntry[] }) => {
      expect(batch.expectedHeadSeq).toBe(entries.length);
      entries.push(...structuredClone(batch.entries));
      return { headSeq: entries.length };
    }),
    invoke: vi.fn(async (_task: string, request: { toolCallId: string }) => ({ toolCallId: request.toolCallId, workspaceRevision: "8", data: { content: "真实工具结果：中文" }, truncated: false })),
    progress: vi.fn(async (_task: string, item: { kind: string; text: string }) => { progressItems.push(item); return { accepted: true }; }),
  };
  return { backend, entries, progressItems };
}
async function task(manager: SessionManager, responses: ScriptedResponse[], observe?: Parameters<typeof scriptedSessionFactory>[1], revision = '7') {
  const fixture = backendFor(manager);
  const pi = await createPiSession({ model: MODEL_CONFIG, paths: privateDirs(), taskId: "new-task", conversationId,
    startRevision: revision, backend: fixture.backend as unknown as BackendClient,
    progress: new ProgressChain(fixture.backend as unknown as BackendClient, "new-task"),
    deps: { createSession: (async (options) => scriptedSessionFactory(responses, observe)(options)) } } as Parameters<typeof createPiSession>[0]);
  return { ...fixture, pi };
}

describe("durable native conversation restoration", () => {
  it('starts a continuation from the saved revision and reads the current user edit', async () => {
    let seen = '';
    const f = await task(history(), [
      { toolCalls: [{ id: 'read-current', name: 'read_file', args: { path: 'Demo.java' } }] },
      { text: 'continued from current saved file' },
    ], context => { seen += JSON.stringify(context); }, '9');
    f.backend.invoke.mockResolvedValue({ toolCallId: 'read-current', workspaceRevision: '9', data: { content: 'user saved B' }, truncated: false });
    const result = await f.pi.run({ prompt: 'continue', workspaceRevision: '9' });
    expect(result.state).toBe('COMPLETED');
    expect(seen).toContain('Current workspace revision: 9');
    expect(seen).toContain('user saved B');
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
    expect(f.backend.invoke.mock.calls[0]?.[0]).toBe('new-task');
    f.pi.dispose();
  });
  it("flushes only an acknowledged suffix in atomic batches within both protocol bounds", async () => {
    const fixture = await task(history(), [{ text: "完成" }], (_context, session) => {
      for (let index = 0; index < 40; index++) session.sessionManager.appendCustomEntry("test-metadata", { index });
      for (let index = 0; index < 3; index++) session.sessionManager.appendCustomMessageEntry("test-large", "中".repeat(500_000), false);
    });
    expect((await fixture.pi.run({ prompt: "继续", workspaceRevision: "7" })).state).toBe("COMPLETED");
    const batches = fixture.backend.appendContext.mock.calls.map(([, batch]) => batch);
    expect(batches.length).toBeGreaterThan(3);
    expect(batches.every((batch) => batch.entries.length <= 32 && Buffer.byteLength(JSON.stringify(batch), "utf8") <= 4 * 1024 * 1024)).toBe(true);
    const ids = batches.flatMap((batch) => batch.entries.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(fixture.entries.filter((entry) => entry.type === "custom" && entry.customType === "test-metadata")).toHaveLength(40);
  });
  it("restores native custom messages without altering Chinese or structured content", () => {
    const original = history();
    const restored = SessionManager.inMemory("/scratch", { id: conversationId }, [original.getHeader()!, ...original.getEntries()]);
    expect(restored.getEntries()).toEqual(original.getEntries());
    expect(restored.buildSessionContext().messages).toEqual(original.buildSessionContext().messages);
  });
  it("feeds complete previous goals to the next model and persists final assistant before terminal", async () => {
    let seen = "";
    const fixture = await task(history(), [{ text: "本轮完成" }], (context) => { seen = JSON.stringify(context); });
    const outcome = await fixture.pi.run({ prompt: "本轮新目标", workspaceRevision: "7" });
    expect(seen).toContain("旧目标：字段必须保留 bookId。");
    expect(seen).toContain("中文".repeat(5000));
    expect(seen).not.toContain("本轮新目标");
    expect(outcome.summary).toBe("本轮完成");
    expect(JSON.stringify(fixture.entries)).toContain("本轮完成");
    expect(fixture.backend.appendContext).toHaveBeenCalled();
  });
  it("keeps an independent conversation free of another conversation's goals", async () => {
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    manager.appendCustomMessageEntry("manao_user_request", "另一会话的独立目标", true);
    let seen = "";
    const fixture = await task(manager, [{ text: "完成" }], (context) => { seen = JSON.stringify(context); });
    await fixture.pi.run({ prompt: "继续", workspaceRevision: "7" });
    expect(seen).toContain("另一会话的独立目标");
    expect(seen).not.toContain("bookId");
  });
  it("creates a fresh second task from the first task's acknowledged native history", async () => {
    const manager = history();
    const first = await task(manager, [{ toolCalls: [{ id: "first-read", name: "read_file", args: { path: "中文文件.java" } }] }, { text: "上一轮：保留字段约束" }]);
    await first.pi.run({ prompt: "第一轮", workspaceRevision: "7" });
    first.pi.dispose();
    const restored = SessionManager.inMemory("manao-project", { id: conversationId }, [manager.getHeader()!, ...first.entries]);
    restored.appendCustomMessageEntry("manao_user_request", "新目标：加一个查询接口", true, { taskId: "second-task" });
    let seen = "";
    const second = await task(restored, [{ text: "第二轮完成" }], (context) => { seen = JSON.stringify(context); });
    const outcome = await second.pi.run({ prompt: "第二轮", workspaceRevision: "7" });
    expect(seen).toContain("bookId");
    expect(seen).toContain("上一轮：保留字段约束");
    expect(seen).toContain("真实工具结果：中文");
    expect(seen).toContain("中文文件.java");
    expect(seen).toContain("新目标：加一个查询接口");
    expect(second.backend.invoke).not.toHaveBeenCalled();
    expect(outcome.summary).toBe("第二轮完成");
  });
  it("does not reuse a historic final answer when this round produces no assistant", async () => {
    const manager = history();
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "旧轮成功回答" }], api: "openai-completions", provider: "manao-test", model: "scripted-1", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 });
    const fixture = await task(manager, [{ text: "本轮不应运行" }]);
    fixture.backend.appendContext.mockRejectedValue(new Error("unavailable"));
    const outcome = await fixture.pi.run({ prompt: "继续", workspaceRevision: "7" });
    expect(outcome).toMatchObject({ state: "FAILED", summary: "", failureCode: "AI_CONTEXT_UNAVAILABLE" });
  });
  it("saves after SDK's message_end notification and blocks all later tools on a failed ACK", async () => {
    let observedBeforeAppend = false;
    const fixture = await task(history(), [{ toolCalls: [{ id: "new-a", name: "read_file", args: { path: "a" } }, { id: "new-b", name: "write_file", args: { path: "b", content: "b" } }] }], (_context, session) => {
      session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          observedBeforeAppend ||= !JSON.stringify(session.sessionManager.getEntries()).includes("new-a");
        }
      });
    });
    const append = fixture.backend.appendContext.getMockImplementation()!;
    fixture.backend.appendContext.mockImplementation(async (...args) => {
      if (JSON.stringify(args[1].entries).includes("new-a")) throw new Error("save failed");
      return append(...args);
    });
    expect((await fixture.pi.run({ prompt: "继续", workspaceRevision: "7" })).failureCode).toBe("AI_CONTEXT_UNAVAILABLE");
    expect(observedBeforeAppend).toBe(true);
    expect(fixture.backend.invoke).not.toHaveBeenCalled();
  });
  it("waits for assistant ACK before invoke and result ACK before next provider", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await task(history(), [{ toolCalls: [{ id: "fresh", name: "read_file", args: { path: "pom.xml" } }] }, { text: "完成" }], (context) => {
      if (JSON.stringify(context).includes("真实工具结果")) expect(JSON.stringify(fixture.entries)).toContain("真实工具结果");
    });
    const append = fixture.backend.appendContext.getMockImplementation()!;
    fixture.backend.appendContext.mockImplementation(async (...args) => {
      if (JSON.stringify(args[1].entries).includes('"toolCall"')) await blocked;
      return append(...args);
    });
    const run = fixture.pi.run({ prompt: "继续", workspaceRevision: "7" });
    await vi.waitFor(() => expect(fixture.backend.appendContext.mock.calls.some(([, batch]) => JSON.stringify(batch.entries).includes('"toolCall"'))).toBe(true));
    expect(fixture.backend.invoke).not.toHaveBeenCalled();
    release();
    expect((await run).state).toBe("COMPLETED");
    expect(fixture.backend.invoke).toHaveBeenCalledTimes(1);
  });
  it("fails closed when the final assistant cannot be saved", async () => {
    const fixture = await task(history(), [{ text: "不能误报成功" }]);
    const append = fixture.backend.appendContext.getMockImplementation()!;
    fixture.backend.appendContext.mockImplementation(async (...args) => {
      if (JSON.stringify(args[1]).includes("不能误报成功")) throw new Error("database unavailable");
      return append(...args);
    });
    const outcome = await fixture.pi.run({ prompt: "继续", workspaceRevision: "7" });
    expect(outcome).toMatchObject({ state: "FAILED", failureCode: "AI_CONTEXT_UNAVAILABLE" });
    // The session reports no terminal itself: the server's delivery owns it, and the
    // FAILED outcome above is what gets published after the loop exits.
    expect(fixture.progressItems.some((item) => item.kind === "terminal")).toBe(false);
  });
  it("saves completed failure messages before terminal when a tool outcome is unresolved", async () => {
    const fixture = await task(history(), [{ toolCalls: [{ id: "unknown-call", name: "read_file", args: { path: "a" } }] }]);
    fixture.backend.invoke.mockRejectedValue(new BackendHttpError(0, "AI_CALL_UNKNOWN", "unresolved outcome"));
    expect((await fixture.pi.run({ prompt: "继续", workspaceRevision: "7" })).failureCode).toBe("AI_CALL_UNKNOWN");
    expect(fixture.entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult")).toBe(true);
  });
  it("does not enter the next provider while tool-result persistence remains unresolved", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let providerCalls = 0;
    const fixture = await task(history(), [{ toolCalls: [{ id: "read", name: "read_file", args: { path: "a" } }] }, { text: "最终答案" }], () => { providerCalls++; });
    const append = fixture.backend.appendContext.getMockImplementation()!;
    fixture.backend.appendContext.mockImplementation(async (...args) => {
      if (JSON.stringify(args[1].entries).includes('"toolResult"')) await held;
      return append(...args);
    });
    const running = fixture.pi.run({ prompt: "继续", workspaceRevision: "7" });
    await vi.waitFor(() => expect(fixture.backend.appendContext.mock.calls.some(([, batch]) => JSON.stringify(batch.entries).includes('"toolResult"'))).toBe(true));
    expect(providerCalls).toBe(1);
    expect(fixture.progressItems.some((item) => item.kind === "terminal")).toBe(false);
    release();
    expect((await running).summary).toBe("最终答案");
    expect(providerCalls).toBe(2);
  });
  it("awaits persistence even for direct native summary provider calls bypassing prepareRequest", async () => {
    let session!: Parameters<NonNullable<Parameters<typeof scriptedSessionFactory>[1]>>[1];
    const fixture = await task(history(), [{ text: "摘要" }], (_context, value) => { session = value; });
    await fixture.pi.run({ prompt: "继续", workspaceRevision: "7" });
    session.sessionManager.appendCustomMessageEntry("manao_context_note", "待保存的新条目", false);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const append = fixture.backend.appendContext.getMockImplementation()!;
    fixture.backend.appendContext.mockImplementation(async (...args) => { await held; return append(...args); });
    let providerEntered = false;
    const direct = session.agent.streamFunction(session.model!, { messages: [] });
    Promise.resolve(direct).then(() => { providerEntered = true; });
    await vi.waitFor(() => expect(fixture.backend.appendContext.mock.calls.at(-1)?.[1].entries.some((entry) => JSON.stringify(entry).includes("待保存的新条目"))).toBe(true));
    expect(providerEntered).toBe(false);
    release();
    await direct;
    expect(JSON.stringify(fixture.entries)).toContain("待保存的新条目");
  });
  it("omits an interrupted old tool round and its partial results without executing old calls", async () => {
    const manager = history();
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "old-a", name: "read_file", arguments: { path: "a" } }, { type: "toolCall", id: "old-b", name: "write_file", arguments: { path: "b", content: "old" } }], api: "openai-completions", provider: "manao-test", model: "scripted-1", stopReason: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 });
    manager.appendMessage({ role: "toolResult", toolCallId: "old-a", toolName: "read_file", content: [{ type: "text", text: "partial-old-result" }], isError: false, timestamp: 2 });
    let seen = "";
    const fixture = await task(manager, [{ text: "新轮完成" }], (context) => { seen = JSON.stringify(context); });
    expect((await fixture.pi.run({ prompt: "继续", workspaceRevision: "7" })).state).toBe("COMPLETED");
    expect(seen).not.toContain("old-a");
    expect(seen).not.toContain("partial-old-result");
    expect(fixture.backend.invoke).not.toHaveBeenCalled();
    expect(fixture.entries.filter((entry) => entry.type === "context_edit")).toHaveLength(2);
  });
});

describe("native ACK observer contract", () => {
  it("reports each acknowledged original batch only and isolates display observer failure from durable success", async () => {
    const { ConversationContext } = await import("../src/conversation-context.js");
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    const fixture = backendFor(manager);
    const context = await ConversationContext.load(fixture.backend as unknown as BackendClient, "new-task", conversationId);
    for (let index = 0; index < 35; index++) manager.appendCustomEntry("native-contract", { index });
    const original = manager.getEntries();
    const observed: Array<{ entries: SessionEntry[]; head: number }> = [];
    await context.flush({ sessionManager: manager, getContextUsage: () => undefined } as any, (entries, head) => {
      observed.push({ entries, head });
      throw new Error("display notification failed");
    });
    expect(observed.map(({ entries, head }) => [entries.length, head])).toEqual([[32, 32], [3, 35]]);
    expect(observed[0]!.entries[0]).toBe(original[0]);
    expect(observed[0]!.entries[31]).toBe(original[31]);
    expect(observed[1]!.entries[0]).toBe(original[32]);
    expect(observed[0]!.entries[0]).not.toBe(fixture.backend.appendContext.mock.calls[0]![1].entries[0]);
    await context.flush({ sessionManager: manager, getContextUsage: () => undefined } as any, () => { throw new Error("should not repeat ACK"); });
    expect(fixture.backend.appendContext).toHaveBeenCalledTimes(2);
    expect(context.acknowledgedHeadSeq).toBe(35);
  });

  it("does not notify an unconfirmed original suffix after a mismatched ACK", async () => {
    const { ConversationContext } = await import("../src/conversation-context.js");
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    const fixture = backendFor(manager);
    const context = await ConversationContext.load(fixture.backend as unknown as BackendClient, "new-task", conversationId);
    manager.appendCustomEntry("unconfirmed", {});
    fixture.backend.appendContext.mockResolvedValue({ headSeq: 0 });
    let observed = 0;
    await expect(context.flush({ sessionManager: manager, getContextUsage: () => undefined } as any, () => { observed++; })).rejects.toMatchObject({ code: "AI_CONTEXT_UNAVAILABLE" });
    expect(observed).toBe(0);
    expect(context.acknowledgedHeadSeq).toBe(0);
  });
});
