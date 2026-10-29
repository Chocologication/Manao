import { describe, expect, it, vi } from "vitest";
import { SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { BackendClient, ProgressChain } from "../src/backend-client.js";
import type { ContextAppend } from "../src/conversation-context.js";
import { createPiSession } from "../src/pi-session.js";
import { MODEL_CONFIG, privateDirs, scriptedSessionFactory, type ScriptedResponse } from "./scripted-session.js";

const id = "00000000-0000-4000-8000-000000000001";
const summary = "目标：图书CRUD；约束：bookId。修改 src/Book.java；BUILD SUCCESS exitCode=0；HTTP 200；下一步查询接口。";
const tools = ["list_files", "read_file", "write_file", "build", "application", "app_http_get"];
function assistant(text: string, tokens = 100) {
  return { role: "assistant" as const, content: [{ type: "text" as const, text }], api: "openai-completions" as const,
    provider: "manao-test", model: "scripted-1", stopReason: "stop" as const,
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 };
}
function history() {
  const manager = SessionManager.inMemory("manao-project", { id });
  manager.appendCustomMessageEntry("manao_user_request", "目标：图书CRUD；明确约束：字段必须保留 bookId。", true);
  for (const [index, name] of tools.entries()) {
    manager.appendMessage({ ...assistant("tool evidence"), stopReason: "toolUse", content: [{ type: "toolCall", id: `old-${index}`, name,
      arguments: { path: "src/Book.java", goal: "test", action: "status", url: "/books" } }] });
    manager.appendMessage({ role: "toolResult", toolCallId: `old-${index}`, toolName: name, content: [{ type: "text",
      text: JSON.stringify({ tool: name, path: "src/Book.java", exitCode: 0, output: "BUILD SUCCESS", status: 200, body: "bookId=7" }) }],
      isError: false, timestamp: 1 });
  }
  manager.appendCustomMessageEntry("manao_user_request", "最近目标：继续查询接口。" + "r".repeat(80_000), true);
  manager.appendMessage(assistant("最近已读文件"));
  return manager;
}
type Respond = NonNullable<Parameters<typeof scriptedSessionFactory>[2]>;
async function fixture(manager: SessionManager, respond: Respond, seconds = 1800, fixedSdkConfig = false, now?: () => number) {
  const entries = structuredClone(manager.getEntries());
  const batches: ContextAppend[] = [];
  const requests: Array<{ summary: boolean; context: TranscriptContext }> = [];
  let session!: AgentSession;
  const backend = {
    readContext: vi.fn(async (_task: string, after = 0, through?: number) => ({ header: manager.getHeader(), headSeq: through ?? entries.length,
      entries: entries.slice(after, through ?? entries.length).map((entry, index) => ({ seq: after + index + 1, sourceTaskId: null, writerId: "task", entry })), nextAfterSeq: null })),
    appendContext: vi.fn(async (_task: string, batch: ContextAppend) => {
      expect(batch.expectedHeadSeq).toBe(entries.length);
      batches.push(structuredClone(batch)); entries.push(...structuredClone(batch.entries));
      return { headSeq: entries.length };
    }),
    invoke: vi.fn(async (_task: string, request: { toolCallId: string }) => ({ toolCallId: request.toolCallId, workspaceRevision: "8",
      data: { content: "工具结果增长：" + "x".repeat(90_000) }, truncated: false })),
    progress: vi.fn(async () => ({ accepted: true })),
  };
  const pi = await createPiSession({ model: MODEL_CONFIG, paths: privateDirs(), taskId: "task", conversationId: id, startRevision: "7",
    budgets: { wallClockSeconds: seconds, toolCalls: 180, builds: 20 }, backend: backend as unknown as BackendClient,
    progress: new ProgressChain(backend as unknown as BackendClient, "task"),
    deps: { now, createSession: async (options) => {
      if (fixedSdkConfig) {
        options.model = { ...options.model!, contextWindow: 1_048_576 };
        options.settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 262_145, keepRecentTokens: 20_000 },
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1000 } });
      }
      const made = scriptedSessionFactory([], (context, actual) => {
        session = actual; requests.push({ summary: actual.isCompacting, context: structuredClone(context) });
      }, respond)(options); session = made.session; return made;
    } } });
  return { pi, backend, entries, batches, requests, get session() { return session; },
    run: () => pi.run({ prompt: "继续", workspaceRevision: "7" }) };
}

describe("fixed-window native Pi compaction", () => {
  it.each([[786431, 0], [786432, 1], [786433, 1]])("compacts native assistant usage %i with inclusive 75 percent boundary", async (tokens, count) => {
    const f = await fixture(history(), (_context, session) => session.isCompacting ? { text: summary } : { text: "本轮完成", usageTokens: tokens });
    expect((await f.run()).state).toBe("COMPLETED");
    expect(f.entries.filter((entry) => entry.type === "compaction")).toHaveLength(count);
    expect(f.session.model!.contextWindow).toBe(1_048_576);
    expect(f.session.model!.maxTokens).toBe(8192);
    expect(f.session.settingsManager.getCompactionSettings(f.session.model)).toEqual({ enabled: true, reserveTokens: 262_145, keepRecentTokens: 20_000 });
    expect(f.requests.filter((request) => request.summary)).toHaveLength(count);
    if (count) {
      expect(f.batches.at(-1)!.usage).toEqual({ tokens: null, contextWindow: 1_048_576, percent: null });
      expect(f.entries.filter((entry) => entry.type === "message")).toHaveLength(16);
    }
    f.pi.dispose();
  });

  it("compacts a newly appended goal before the first programming request and keeps original history", async () => {
    const manager = history();
    manager.appendMessage(assistant("prior usage below threshold", 786_000));
    manager.appendCustomMessageEntry("manao_user_request", "新目标必须遵守 bookId。" + "g".repeat(4000), true);
    const original = structuredClone(manager.getEntries());
    const f = await fixture(manager, (_context, session) => session.isCompacting ? { text: summary } : { text: "已遵守约束" }, 1800, true);
    expect((await f.run()).state).toBe("COMPLETED");
    expect(f.requests[0]!.summary).toBe(true);
    const programming = JSON.stringify(f.requests.find((request) => !request.summary)!.context);
    expect(programming).toContain(summary); expect(programming).toContain("新目标必须遵守 bookId。");
    expect(programming).toContain("最近目标：继续查询接口。");
    expect(programming).toContain("six mediated tools"); expect(programming).toContain("app_http_get");
    expect(f.entries.slice(0, original.length)).toEqual(original);
    expect(f.backend.invoke).not.toHaveBeenCalled();
    f.pi.dispose();
  });

  it("uses actual six-tool evidence in native summaries and repeats compaction from the previous summary plus recent tail", async () => {
    let turns = 0;
    const f = await fixture(history(), (_context, session) => {
      if (session.isCompacting) return { text: summary };
      turns++;
      if (turns <= 2) return { text: "继续读取", usageTokens: 785_900,
        toolCalls: [{ id: `new-${turns}`, name: "read_file", args: { path: "src/Book.java" } }] };
      return { text: "完成查询接口" };
    });
    expect((await f.run()).state).toBe("COMPLETED");
    const summaries = f.requests.filter((request) => request.summary);
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    const first = JSON.stringify(summaries[0]!.context);
    for (const name of tools) expect(first).toContain(name);
    for (const evidence of ["bookId", "src/Book.java", "BUILD SUCCESS", "200"]) expect(first).toContain(evidence);
    expect(summaries.slice(1).some((request) => JSON.stringify(request.context).includes(summary))).toBe(true);
    expect(f.entries.filter((entry) => entry.type === "compaction")).toHaveLength(2);
    const ordinary = f.requests.filter((request) => !request.summary);
    expect(JSON.stringify(ordinary[1]!.context)).toContain(summary);
    for (const request of ordinary.slice(1)) {
      const messages = request.context.messages;
      for (const message of messages) if (message.role === "toolResult") {
        expect(messages.some((candidate) => candidate.role === "assistant" && candidate.content.some((block) => block.type === "toolCall" && block.id === message.toolCallId))).toBe(true);
      }
    }
    expect(f.backend.invoke).toHaveBeenCalledTimes(2);
    f.pi.dispose();
  });

  it("includes the pending initial system and six-tool loadout in its idle threshold estimate", async () => {
    const manager = history();
    manager.appendMessage(assistant("below threshold without loadout", 785_900));
    manager.appendCustomMessageEntry("manao_user_request", "继续", true);
    const f = await fixture(manager, (_context, session) => session.isCompacting ? { text: summary } : { text: "完成" });
    expect((await f.run()).state).toBe("COMPLETED");
    expect(f.requests[0]!.summary).toBe(true);
    expect(f.requests.filter((request) => !request.summary)).toHaveLength(1);
    f.pi.dispose();
  });

  it("awaits a fresh ACK before a native transient-summary retry", async () => {
    let summaries = 0;
    const manager = history();
    manager.appendMessage(assistant("prior", 786_000));
    manager.appendCustomMessageEntry("manao_user_request", "new goal" + "g".repeat(4000), true);
    const f = await fixture(manager, (_context, session) => {
      if (!session.isCompacting) return { text: "done" };
      if (++summaries === 1) {
        session.sessionManager.appendCustomEntry("summary-retry-note", { reason: "must be acknowledged" });
        return { errorMessage: "terminated" };
      }
      expect(f.entries.some((entry) => entry.type === "custom" && entry.customType === "summary-retry-note")).toBe(true);
      return { text: summary };
    }, 1800, true);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const append = f.backend.appendContext.getMockImplementation()!;
    f.backend.appendContext.mockImplementation(async (task, batch) => {
      if (batch.entries.some((entry) => entry.type === "custom" && entry.customType === "summary-retry-note")) await held;
      return append(task, batch);
    });
    const running = f.run();
    await vi.waitFor(() => expect(f.backend.appendContext.mock.calls.some(([, batch]) => batch.entries.some((entry) => entry.type === "custom" && entry.customType === "summary-retry-note"))).toBe(true));
    expect(summaries).toBe(1);
    release();
    expect((await running).state).toBe("COMPLETED");
    expect(summaries).toBe(2);
    f.pi.dispose();
  });

  it("fails closed after native automatic summary failure instead of sending another programming request", async () => {
    let ordinary = 0;
    const f = await fixture(history(), (_context, session) => session.isCompacting
      ? { text: "", errorMessage: "summary rejected" }
      : (++ordinary === 1 ? { usageTokens: 785_900, toolCalls: [{ id: "grow", name: "read_file", args: { path: "src/Book.java" } }] } : { text: "forbidden subsequent request" }));
    const outcome = await f.run();
    expect(outcome).toMatchObject({ state: "FAILED", failureCode: "AI_CONTEXT_COMPACTION_FAILED" });
    expect(ordinary).toBe(1);
    expect(f.entries.some((entry) => entry.type === "compaction")).toBe(false);
    expect(f.entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "grow")).toBe(true);
    f.pi.dispose();
  });

  it("fails closed when native compaction has no summarizable entries", async () => {
    const manager = SessionManager.inMemory("manao-project", { id });
    manager.appendCustomMessageEntry("manao_user_request", "current goal", true);
    manager.appendMessage(assistant("inflated usage", 786_432));
    const f = await fixture(manager, () => ({ text: "must not be requested" }));
    expect(await f.run()).toMatchObject({ state: "FAILED", failureCode: "AI_CONTEXT_COMPACTION_FAILED" });
    expect(f.requests).toHaveLength(0);
    f.pi.dispose();
  });

  it("requires compaction ACK before the next programming provider call", async () => {
    let ordinary = 0;
    const f = await fixture(history(), (_context, session) => session.isCompacting ? { text: summary }
      : (++ordinary === 1 ? { usageTokens: 785_900, toolCalls: [{ id: "grow", name: "read_file", args: { path: "src/Book.java" } }] } : { text: "forbidden subsequent request" }));
    const append = f.backend.appendContext.getMockImplementation()!;
    f.backend.appendContext.mockImplementation(async (task, batch) => {
      if (batch.entries.some((entry) => entry.type === "compaction")) throw new Error("ACK unavailable");
      return append(task, batch);
    });
    expect(await f.run()).toMatchObject({ state: "FAILED", failureCode: "AI_CONTEXT_UNAVAILABLE" });
    expect(ordinary).toBe(1);
    f.pi.dispose();
  });

  it("persists the current SDK usage plus unmeasured tool tail without adding prior provider bills", async () => {
    let ordinary = 0;
    const f = await fixture(history(), () => ++ordinary === 1 ? { usageTokens: 12_345,
      toolCalls: [{ id: "measured", name: "read_file", args: { path: "src/Book.java" } }] } : { text: "done", usageTokens: 5432 });
    expect((await f.run()).state).toBe("COMPLETED");
    expect(f.batches.some((batch) => batch.usage?.tokens === 12_345)).toBe(true);
    expect(f.batches.some((batch) => batch.usage?.tokens !== null && batch.usage && batch.usage.tokens! > 34_800)).toBe(true);
    expect(f.batches.at(-1)!.usage).toEqual({ tokens: 5432, contextWindow: 1_048_576, percent: 5432 * 100 / 1_048_576 });
    expect(f.requests.every((request) => !request.summary)).toBe(true);
    f.pi.dispose();
  });

  it("settles a failed final-response auto-summary with the fixed context failure code", async () => {
    const f = await fixture(history(), (_context, session) => session.isCompacting ? { errorMessage: "summary rejected" }
      : { text: "final answer", usageTokens: 786_432 });
    expect(await f.run()).toMatchObject({ state: "FAILED", failureCode: "AI_CONTEXT_COMPACTION_FAILED" });
    expect(f.requests.filter((request) => !request.summary)).toHaveLength(1);
    expect(f.entries.some((entry) => entry.type === "compaction")).toBe(false);
    f.pi.dispose();
  });

  it.each(["initial", "summary"])("does not start a provider after stop while the %s ACK is pending", async (phase) => {
    const manager = history();
    if (phase === "initial") {
      manager.appendMessage(assistant("prior", 786_000));
      manager.appendCustomMessageEntry("manao_user_request", "fresh goal" + "g".repeat(4000), true);
    }
    const f = await fixture(manager, (_context, session) => session.isCompacting ? { text: summary } : {
      usageTokens: 785_900, toolCalls: [{ id: "grow", name: "read_file", args: { path: "src/Book.java" } }] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let waiting!: () => void;
    const blocked = new Promise<void>((resolve) => { waiting = resolve; });
    const append = f.backend.appendContext.getMockImplementation()!;
    f.backend.appendContext.mockImplementation(async (task, batch) => {
      if (phase === "initial" || batch.entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult")) {
        waiting(); await held;
      }
      return append(task, batch);
    });
    const running = f.run(); await blocked;
    f.pi.stop(); release();
    expect(await running).toMatchObject({ state: "FAILED", failureCode: "AI_ABORTED" });
    expect(f.requests).toHaveLength(phase === "initial" ? 0 : 1);
    f.pi.dispose();
  });

  it("records a fired idle-compaction deadline even at the exact clock boundary", async () => {
    const manager = history();
    manager.appendMessage(assistant("prior", 786_000));
    manager.appendCustomMessageEntry("manao_user_request", "fresh goal" + "g".repeat(4000), true);
    let clock = 1000;
    const f = await fixture(manager, (_context, _session, signal) => {
      clock = 1050;
      return new Promise<ScriptedResponse>(resolve => signal!.addEventListener("abort", () => resolve({ stopReason: "aborted" }), { once: true }));
    }, 0.05, false, () => clock);
    try {
      expect(await f.run()).toMatchObject({ state: "FAILED", failureCode: "AI_BUDGET_EXCEEDED" });
      expect(f.requests.every(request => request.summary)).toBe(true);
    } finally { f.pi.dispose(); }
  });

  it.each(["stop", "deadline"])("cancels idle pre-prompt compaction honestly on %s", async (mode) => {
    const manager = history();
    manager.appendMessage(assistant("prior", 786_000));
    manager.appendCustomMessageEntry("manao_user_request", "fresh goal" + "g".repeat(4000), true);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let signal!: AbortSignal;
    const f = await fixture(manager, (_context, _session, currentSignal) => {
      signal = currentSignal!; entered();
      return new Promise<ScriptedResponse>((resolve) => signal.addEventListener("abort", () => resolve({ stopReason: "aborted" }), { once: true }));
    }, mode === "deadline" ? 0.05 : 1800);
    const running = f.run(); await started;
    if (mode === "stop") f.pi.stop();
    const outcome = await running;
    expect(signal.aborted).toBe(true);
    expect(outcome.failureCode).toBe(mode === "stop" ? "AI_ABORTED" : "AI_BUDGET_EXCEEDED");
    expect(f.requests.every((request) => request.summary)).toBe(true);
    f.pi.dispose();
  });

  it.each(["stop", "deadline"])("aborts the real independent summary provider signal on %s", async (mode) => {
    let finish!: (response: ScriptedResponse) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let signal: AbortSignal | undefined;
    let agentSignal: AbortSignal | undefined;
    const f = await fixture(history(), (_context, session, currentSignal) => {
      if (!session.isCompacting) {
        agentSignal = currentSignal;
        return { usageTokens: 785_900, toolCalls: [{ id: "grow", name: "read_file", args: { path: "src/Book.java" } }] };
      }
      signal = currentSignal; entered();
      return new Promise<ScriptedResponse>((resolve) => {
        finish = resolve;
        currentSignal!.addEventListener("abort", () => resolve({ stopReason: "aborted" }), { once: true });
      });
    }, mode === "deadline" ? 0.05 : 1800);
    const running = f.run(); await started;
    const agentAbort = vi.spyOn(f.session.agent, "abort");
    if (mode === "stop") f.pi.stop();
    else await new Promise((resolve) => setTimeout(resolve, 100));
    const aborted = signal!.aborted;
    finish({ stopReason: "aborted" });
    const outcome = await running;
    expect(aborted).toBe(true); expect(agentAbort).toHaveBeenCalled();
    expect(agentSignal!.aborted).toBe(true);
    expect(outcome.failureCode).toBe(mode === "stop" ? "AI_ABORTED" : "AI_BUDGET_EXCEEDED");
    expect(f.requests.filter((request) => !request.summary)).toHaveLength(1);
    f.pi.dispose();
  });
});
