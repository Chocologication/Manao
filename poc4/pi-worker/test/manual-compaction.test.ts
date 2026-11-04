import { JAVA_ENVIRONMENT, JAVA_SHA256, PYTHON_ENVIRONMENT } from "./environment-fixtures.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createTaskServer } from "../src/server.js";
import type { WorkerConfig } from "../src/config.js";
import { compactIdleConversation, createPiSession } from "../src/pi-session.js";
import { ProgressChain } from "../src/backend-client.js";
import type { BackendClient } from "../src/backend-client.js";
import { MODEL_CONFIG, privateDirs, scriptedSessionFactory } from "./scripted-session.js";

const conversationId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const handles: ReturnType<typeof createTaskServer>[] = [];
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close(); });
const config = (): WorkerConfig => ({ port: 0, workerToken: "worker-token", backendToken: "backend-token",
  backendBaseUrl: "http://127.0.0.1:9", instanceId: "worker-1", bootId: "boot-test", model: { ...MODEL_CONFIG, baseUrl: "https://api.deepseek.com" }, paths: privateDirs(),
  budgets: { wallClockSeconds: 1800, toolCalls: 180, builds: 20 } });
async function post(base: string, path: string, body: unknown) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-manao-worker-token": "worker-token" }, body: JSON.stringify(body) });
}
describe("manual compact HTTP admission", () => {
  it("accepts an idle compact immediately with its instance and registered identity", async () => {
    const handle = createTaskServer(config()); handles.push(handle);
    const base = `http://127.0.0.1:${await handle.listen()}`;
    const response = await post(base, `/conversations/${conversationId}/compact`, { conversationId, requestId, expectedHeadSeq: 0 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversationId, requestId, instanceId: "worker-1", state: "RUNNING" });
  });
  it("refuses compact while any task uses the shared execution slot", async () => {
    const handle = createTaskServer(config(), { createRunner: () => ({ taskId: "task", state: () => "RUNNING",
      start: () => new Promise<void>(() => {}), stop: async () => {} }) }); handles.push(handle);
    const base = `http://127.0.0.1:${await handle.listen()}`;
    expect((await post(base, "/tasks/task/start", { environment: JAVA_ENVIRONMENT, environmentSha256: JAVA_SHA256, taskId: "task", prompt: "goal", workspaceRevision: "7", requestSha256: "a".repeat(64), workerEpoch: 1, reasoningEffort: "high" })).status).toBe(200);
    expect((await post(base, `/conversations/${conversationId}/compact`, { conversationId, requestId, expectedHeadSeq: 0 })).status).toBe(409);
  });
  it("uses native compact only, returns status on duplicate starts and reconciles a lost result ACK without resummarizing", async () => {
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    manager.appendCustomMessageEntry("manao_user_request", "保留 bookId；创建图书接口。" + "x".repeat(100_000), true);
    manager.appendCustomMessageEntry("manao_user_request", "最近目标" + "y".repeat(100_000), true);
    const entries = structuredClone(manager.getEntries());
    const submissions: unknown[] = [];
    let drop = true;
    const backend = createServer((req, res) => {
      if (req.method === "GET") { res.end(JSON.stringify({ header: manager.getHeader(), headSeq: entries.length,
        entries: entries.map((entry, i) => ({ seq: i + 1, sourceTaskId: null, writerId: "old", entry })), nextAfterSeq: null })); return; }
      let raw = ""; req.on("data", chunk => { raw += String(chunk); }); req.on("end", () => {
        submissions.push(JSON.parse(raw));
        if (drop) { drop = false; req.socket.destroy(); return; }
        res.end(JSON.stringify({ headSeq: entries.length + (JSON.parse(raw).entries as unknown[]).length }));
      });
    });
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let session!: AgentSession;
    let summaries = 0;
    const prompt = vi.fn();
    const factory = scriptedSessionFactory([], undefined, async (_context, actual) => {
      expect(actual.isCompacting).toBe(true); summaries++; await wait; return { text: "约束 bookId；待完成图书查询接口。" };
    });
    const handle = createTaskServer({ ...config(), backendBaseUrl: `http://127.0.0.1:${(backend.address() as AddressInfo).port}` }, {
      createManualSession: async (options: Parameters<typeof factory>[0]) => {
        expect(options.tools).toEqual([]); expect(options.customTools).toEqual([]);
        const made = await factory(options); session = made.session; vi.spyOn(session, "prompt").mockImplementation(prompt); return made;
      },
    } as never); handles.push(handle);
    const base = `http://127.0.0.1:${await handle.listen()}`;
    const body = { conversationId, requestId, expectedHeadSeq: entries.length };
    try {
      expect((await post(base, `/conversations/${conversationId}/compact`, body)).status).toBe(200);
      await vi.waitFor(() => expect(summaries).toBe(1));
      expect((await post(base, `/tasks/new/start`, { environment: JAVA_ENVIRONMENT, environmentSha256: JAVA_SHA256, taskId: "new", prompt: "goal", workspaceRevision: "7", requestSha256: "a".repeat(64), workerEpoch: 1, reasoningEffort: "high" })).status).toBe(409);
      expect((await post(base, `/conversations/${conversationId}/compact`, body)).status).toBe(200);
      expect((await post(base, `/conversations/${conversationId}/compact`, { ...body, expectedHeadSeq: 1 })).status).toBe(409);
      release();
      await vi.waitFor(() => expect(submissions).toHaveLength(1));
      await vi.waitFor(async () => {
        const status = await fetch(base + `/conversations/${conversationId}/compactions/${requestId}`, { headers: { "x-manao-worker-token": "worker-token" } });
        expect(await status.json()).toMatchObject({ state: "COMPLETED", instanceId: "worker-1" });
      });
      expect(submissions).toHaveLength(2); expect(submissions[1]).toEqual(submissions[0]);
      expect(summaries).toBe(1); expect(prompt).not.toHaveBeenCalled();
      expect(session.getActiveToolNames()).toEqual([]);
      expect((submissions[0] as { entries: Array<{ type: string }> }).entries.filter(entry => entry.type === "compaction")).toHaveLength(1);
      expect(manager.getEntries()).toEqual(entries);
    } finally { release(); await new Promise<void>(resolve => backend.close(() => resolve())); }
  });
  it("reports failed after the backend definitively rejects a stale result instead of claiming success", async () => {
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    const backend = createServer((req, res) => {
      if (req.method === "GET") res.end(JSON.stringify({ header: manager.getHeader(), headSeq: 0, entries: [], nextAfterSeq: null }));
      else { req.resume(); req.on("end", () => { res.writeHead(409); res.end(JSON.stringify({ code: "AI_CONTEXT_CONFLICT" })); }); }
    });
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const handle = createTaskServer({ ...config(), backendBaseUrl: `http://127.0.0.1:${(backend.address() as AddressInfo).port}` }); handles.push(handle);
    const base = `http://127.0.0.1:${await handle.listen()}`;
    try {
      await post(base, `/conversations/${conversationId}/compact`, { conversationId, requestId, expectedHeadSeq: 0 });
      await vi.waitFor(async () => {
        const response = await fetch(base + `/conversations/${conversationId}/compactions/${requestId}`, { headers: { "x-manao-worker-token": "worker-token" } });
        expect(await response.json()).toMatchObject({ state: "FAILED" });
      });
    } finally { await new Promise<void>(resolve => backend.close(() => resolve())); }
  });
  it("answers status immediately while a terminal callback HTTP response remains unresolved", async () => {
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    let callback!: import("node:http").ServerResponse;
    const backend = createServer((req, res) => {
      if (req.method === "GET") res.end(JSON.stringify({ header: manager.getHeader(), headSeq: 0, entries: [], nextAfterSeq: null }));
      else { req.resume(); req.on("end", () => { callback = res; }); }
    });
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const handle = createTaskServer({ ...config(), backendBaseUrl: `http://127.0.0.1:${(backend.address() as AddressInfo).port}` }); handles.push(handle);
    const base = `http://127.0.0.1:${await handle.listen()}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect((await post(base, `/conversations/${conversationId}/compact`, { conversationId, requestId, expectedHeadSeq: 0 })).status).toBe(200);
      await vi.waitFor(() => expect(callback).toBeDefined());
      const response = fetch(base + `/conversations/${conversationId}/compactions/${requestId}`, { headers: { "x-manao-worker-token": "worker-token" } }).then(reply => reply.json());
      const result = await Promise.race([response, new Promise(resolve => { timer = setTimeout(() => resolve("blocked on callback"), 500); })]);
      expect(result).toMatchObject({ state: "RUNNING", instanceId: "worker-1" });
    } finally { clearTimeout(timer); callback?.end(JSON.stringify({ headSeq: 0 })); await new Promise<void>(resolve => backend.close(() => resolve())); }
  });
});

describe("native idle summary outcomes", () => {
  it("reinjects current Python environment and tools in the next task after a manual old-Java summary", async () => {
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    manager.appendCustomMessageEntry("manao_user_request", "历史 Java Spring Boot Maven package" + "x".repeat(100_000), true);
    manager.appendCustomMessageEntry("manao_user_request", "最近目标" + "y".repeat(100_000), true);
    const compacted = await run(manager, context => {
      expect(context.messages.some(item => item.role === "system" && item.toolsAdded?.length)).toBe(false);
      return { text: "历史 Spring Boot Maven 摘要，下一任务必须核对环境。" };
    });
    const entries = [...structuredClone(manager.getEntries()), ...compacted.entries];
    const backend = {
      readContext: async () => ({ header: manager.getHeader(), headSeq: entries.length,
        entries: entries.map((entry, i) => ({ seq: i + 1, sourceTaskId: null, writerId: "old", entry })), nextAfterSeq: null }),
      appendContext: async (_task: string, batch: { entries: typeof entries }) => {
        entries.push(...structuredClone(batch.entries)); return { headSeq: entries.length };
      }, progress: async () => ({ accepted: true }),
    } as unknown as BackendClient;
    let requests = 0;
    const pi = await createPiSession({ environment: PYTHON_ENVIRONMENT, model: MODEL_CONFIG, paths: privateDirs(), backend,
      taskId: "next-python", conversationId, progress: new ProgressChain(backend, "next-python"),
      deps: { createSession: async options => scriptedSessionFactory([{ text: "done" }], context => {
        requests++;
        expect(JSON.stringify(context)).toContain('python-fastapi-web');
        const declarations = context.messages.filter(item => item.role === "system").flatMap(item => item.toolsAdded ?? []);
        expect(declarations.some(tool => tool.name === "python_dependencies")).toBe(true);
        const build = declarations.filter(tool => tool.name === "build").at(-1)!;
        expect(JSON.stringify(build.parameters)).not.toContain("package");
      })(options) } });
    try {
      expect((await pi.run({ prompt: "continue current Python", workspaceRevision: "7" })).state).toBe("COMPLETED");
      expect(requests).toBe(1);
    } finally { pi.dispose(); }
  });
  async function run(manager: SessionManager, respond: NonNullable<Parameters<typeof scriptedSessionFactory>[2]>, observe?: (session: AgentSession) => void) {
    const entries = structuredClone(manager.getEntries());
    const backend = { readCompactionContext: async () => ({ header: manager.getHeader(), headSeq: entries.length,
      entries: entries.map((entry, i) => ({ seq: i + 1, sourceTaskId: null, writerId: "old", entry })), nextAfterSeq: null }) };
    return compactIdleConversation({ model: MODEL_CONFIG, paths: privateDirs(), backend: backend as unknown as BackendClient,
      start: { conversationId, requestId, expectedHeadSeq: entries.length },
      createSession: async options => { const made = await scriptedSessionFactory([], undefined, respond)(options); observe?.(made.session); return made; } });
  }
  it("sends Manao checkpoint rules in native manual and turn-prefix summaries without project tools", async () => {
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    manager.appendCustomMessageEntry("manao_user_request", "保留用户约束 bookId。" + "x".repeat(100_000), true);
    manager.appendCustomMessageEntry("manao_user_request", "最新请求：完善查询。" + "y".repeat(100_000), true);
    const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "已检查文件" }],
      api: "openai-completions" as const, provider: "manao-test", model: "scripted-1", stopReason: "stop" as const,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 };
    manager.appendMessage(message);
    manager.appendMessage({ ...message, content: [{ type: "text", text: "当前工作" + "z".repeat(100_000) }] });
    const original = structuredClone(manager.getEntries());
    const summaryInputs: string[] = [];
    const result = await run(manager, context => {
      const first = context.messages[0];
      expect(first?.role).toBe("system");
      if (first?.role === "system") {
        const text = getSystemMessageText(first);
        expect(text).toContain("You are a context summarization assistant.");
        expect(text).toContain("Manao continuation checkpoint rules");
        expect(text).not.toContain("You are the Manao coding agent");
      }
      expect(context.messages.some(item => item.role === "system" && item.toolsAdded?.length)).toBe(false);
      summaryInputs.push(JSON.stringify(context.messages.slice(1)));
      return { text: "用户要求保留 bookId；已检查文件，待完善查询。" };
    });
    expect(summaryInputs.some(input => input.includes("<conversation>"))).toBe(true);
    expect(summaryInputs.some(input => input.includes("# Conversation"))).toBe(true);
    expect(result.entries.some(entry => entry.type === "compaction")).toBe(true);
    expect(manager.getEntries()).toEqual(original);
  });
  it.each(["empty", "already-compacted"])("returns completed no-op for verified native %s without a model request", async kind => {
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    if (kind === "already-compacted") {
      const goal = manager.appendCustomMessageEntry("manao_user_request", "goal", true);
      manager.appendCompaction("已有摘要 bookId", goal, 100);
    }
    const respond = vi.fn(() => ({ text: "a model must not be used" }));
    const result = await run(manager, respond);
    expect(result).toEqual({ expectedHeadSeq: manager.getEntries().length, entries: [], usage: null, failureCode: null });
    expect(respond).not.toHaveBeenCalled();
  });
  it("aborts the native summary at 120 seconds, awaits rejection, and preserves all original history", async () => {
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    manager.appendCustomMessageEntry("manao_user_request", "old" + "x".repeat(100_000), true);
    manager.appendCustomMessageEntry("manao_user_request", "recent" + "y".repeat(100_000), true);
    const original = structuredClone(manager.getEntries());
    let timeout!: () => void;
    const nativeTimer = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 120_000) { timeout = callback; return nativeTimer(() => {}, 1); }
      return nativeTimer(callback, delay, ...args);
    }) as typeof setTimeout);
    let signal!: AbortSignal;
    let stopped = false;
    const operation = run(manager, (_context, _session, currentSignal) => {
      signal = currentSignal!;
      return new Promise(resolve => signal.addEventListener("abort", () => { stopped = true; resolve({ stopReason: "aborted" }); }, { once: true }));
    });
    const settled = operation.then(() => "success", () => "failed");
    try {
      await vi.waitFor(() => expect(signal).toBeDefined());
      expect(signal.aborted).toBe(false); timeout();
      expect(await settled).toBe("failed"); expect(stopped).toBe(true); expect(signal.aborted).toBe(true);
      expect(manager.getEntries()).toEqual(original);
    } finally { timer.mockRestore(); }
  });
  it("does not misclassify a provider error named Already compacted as a successful native no-op", async () => {
    const manager = SessionManager.inMemory("manao-project", { id: conversationId });
    manager.appendCustomMessageEntry("manao_user_request", "old" + "x".repeat(100_000), true);
    manager.appendCustomMessageEntry("manao_user_request", "recent" + "y".repeat(100_000), true);
    const respond = vi.fn(() => { throw new Error("Already compacted"); });
    await expect(run(manager, respond, session => { session.settingsManager.setRetryEnabled(false); })).rejects.toThrow();
    expect(respond).toHaveBeenCalledTimes(1);
  });
});
