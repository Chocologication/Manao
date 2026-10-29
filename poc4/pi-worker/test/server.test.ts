import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendClient, BackendHttpError, ProgressChain } from "../src/backend-client.js";
import { createTaskServer, type WorkerConfig } from "../src/server.js";
import { loadWorkerConfig } from "../src/config.js";
import { terminalContentSha256, terminalReportId } from "../src/report-identity.js";
import { privateDirs, scriptedSessionFactory } from "./scripted-session.js";

/**
 * The canonical test backend for the terminal receipt route: hashes whatever report
 * actually arrived (exactly what the real backend recomputes), so only a report the
 * worker really sent can ever confirm.
 */
function canonicalTerminalHandler(
  terminalBodies: Array<Record<string, unknown>>,
  onProgress?: (body: Record<string, unknown>) => void,
) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf-8");
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url?.endsWith("/terminal")) {
        const received = JSON.parse(raw) as { reportId: string; state: "COMPLETED" | "FAILED"; summary: string; failureCode: string | null };
        terminalBodies.push(received);
        backendResponse(res, 200, {
          reportId: received.reportId,
          reportSha256: terminalContentSha256(received.reportId, received.state, received.summary, received.failureCode),
          disposition: "RECORDED",
        });
        return;
      }
      if (req.url?.includes("/progress")) {
        onProgress?.(JSON.parse(raw) as Record<string, unknown>);
        backendResponse(res, 200, { accepted: true });
        return;
      }
      backendResponse(res, 200, { toolCallId: "call-1", workspaceRevision: "8", data: {}, truncated: false });
    });
  };
}

function backendResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("safe decided backend diagnostics", () => {
  it.each([
    "AI_CALL_UNSETTLED", "AI_CALL_NEEDS_ATTENTION", "AI_TASK_NOT_ACTIVE",
    "AI_CALL_MISMATCH", "AI_CALL_RUNNING", "WORKSPACE_REVISION_CONFLICT", "VALIDATION_ERROR",
  ])("includes only the fixed %s code in a decided409 message without querying or retrying", async (code) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      code, message: "http://private.invalid/secret?token=sensitive", traceId: "private-trace",
    }), { status: 409 }));
    const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
      instanceId: "worker-1", epoch: "epoch-1", fetch: transport });
    await expect(client.invoke("task-1", { toolCallId: "call-1", name: "application", expectedRevision: 7, args: { action: "status" } }))
      .rejects.toMatchObject({ status: 409, code, message: `tool call was refused (409, ${code})` });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1]?.method).toBe("POST");
  });

  it.each(["SECRET_CODE", "PROJECT_BUSY\nhttp://private.invalid?token=sensitive"])("maps an unlisted code to an opaque safe message", async (code) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ code,
      message: "password=sensitive", url: "http://private.invalid", credentials: "private-key" }), { status: 409 }));
    const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
      instanceId: "worker-1", epoch: "epoch-1", fetch: transport });
    let failure: Error | undefined;
    try { await client.invoke("task-1", { toolCallId: "call-1", name: "build", expectedRevision: 7, args: { goal: "test" } }); }
    catch (error) { failure = error as Error; }
    expect(failure?.message).toBe("tool call was refused (409, AI_CALL_REJECTED)");
    expect(failure?.message).not.toMatch(/sensitive|private|SECRET_CODE|password|key/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["http://private.invalid?password=sensitive"])("sanitizes the reconciliation refusal without retrying the original POST", async (code) => {
    const transport = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code, message: "password=sensitive" }), { status: 409 }));
    const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
      instanceId: "worker-1", epoch: "epoch-1", fetch: transport });
    const safeCode = code === "PROJECT_BUSY" ? code : "AI_CALL_REJECTED";
    await expect(client.invoke("task-1", { toolCallId: "call-1", name: "build", expectedRevision: 7, args: { goal: "test" } }))
      .rejects.toMatchObject({ status: 409, message: `tool call reconciliation was refused (409, ${safeCode})` });
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });
});

describe("bounded same-call PROJECT_BUSY admission", () => {
  const request = { toolCallId: "call-busy", name: "build", expectedRevision: 7, args: { goal: "test" } };
  const done = { toolCallId: "call-busy", workspaceRevision: "7", data: { exitCode: 0 }, truncated: false };
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const busy = () => response({ code: "PROJECT_BUSY", message: "private message" }, 409);
  function harness(transport: typeof fetch) {
    let clock = 0;
    const delays: number[] = [];
    const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only", instanceId: "worker-1", epoch: "1", fetch: transport,
      now: () => clock, delay: async (ms) => { clock += ms; delays.push(ms); } });
    return { client, delays, now: () => clock };
  }
  it("queries absence before replaying byte-identical body and identity headers", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(response(null, 404)).mockResolvedValueOnce(response(done));
    const { client } = harness(transport);
    expect(await client.invoke("task-1", request)).toEqual(done);
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "POST"]);
    expect(transport.mock.calls[2]![0]).toBe(transport.mock.calls[0]![0]);
    expect(transport.mock.calls[2]![1]?.body).toBe(transport.mock.calls[0]![1]?.body);
    expect(transport.mock.calls[2]![1]?.headers).toEqual(transport.mock.calls[0]![1]?.headers);
  });
  it("returns a registered completed result without replaying execution", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(response({ state: "COMPLETED", result: done }));
    expect(await harness(transport).client.invoke("task-1", request)).toEqual(done);
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });
  it("caps replay transport timeout to the remaining busy admission time", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy())
        .mockResolvedValueOnce(response(null, 404)).mockResolvedValueOnce(response(done));
      expect(await harness(transport).client.invoke("task-1", request)).toEqual(done);
      expect(timeout.mock.calls.at(-1)![0]).toBe(8000);
    } finally { timeout.mockRestore(); }
  });
  it("waits through a busy GET and a failed read before a proven-absent replay", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy())
      .mockRejectedValueOnce(new TypeError("read lost")).mockResolvedValueOnce(response(null, 404)).mockResolvedValueOnce(response(done));
    const { client, delays } = harness(transport);
    expect(await client.invoke("task-1", request)).toEqual(done);
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "GET", "GET", "POST"]);
    expect(delays.every((ms) => ms <= 2000)).toBe(true);
  });
  it("reconciles a lost replay response through RUNNING and never sends another POST", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(response(null, 404))
      .mockRejectedValueOnce(new TypeError("replay response lost"))
      .mockResolvedValueOnce(response({ state: "RUNNING", result: null })).mockResolvedValueOnce(response({ state: "COMPLETED", result: done }));
    expect(await harness(transport).client.invoke("task-1", request)).toEqual(done);
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "POST", "GET", "GET"]);
  });
  it.each([10000, 3000])("bounds permanent busy reads to the %sms admission cap without execution replay", async (cap) => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => busy());
    const { client, now } = harness(transport);
    await expect(client.invoke("task-1", request, { settleBudgetMs: cap === 10000 ? 720000 : cap }))
      .rejects.toMatchObject({ code: "PROJECT_BUSY" });
    expect(now()).toBe(cap);
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(transport.mock.calls.length).toBeLessThanOrEqual(7);
  });
  it("does not disguise a lost replay outcome as a definite busy refusal", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(response(null, 404))
      .mockRejectedValueOnce(new TypeError("replay reply lost"))
      .mockImplementation(async () => busy());
    const { client, now } = harness(transport);
    await expect(client.invoke("task-1", request)).rejects.toMatchObject({ code: "AI_CALL_UNKNOWN" });
    expect(now()).toBe(720000);
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it("does not turn a registered build's settlement into a ten-second admission timeout", async () => {
    let gets = 0;
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return busy();
      gets++;
      return response(gets <= 8 ? { state: "RUNNING", result: null } : { state: "COMPLETED", result: done });
    });
    const { client, now } = harness(transport);
    expect(await client.invoke("task-1", request)).toEqual(done);
    expect(now()).toBeGreaterThan(10000);
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it.each(["RUNNING", "COMPLETED"])("queries the original %s call after a replay POST uses the entire admission window", async (state) => {
    let clock = 0;
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(response(null, 404))
      .mockImplementationOnce(async () => { clock = 10000; throw new DOMException("response timeout", "TimeoutError"); })
      .mockResolvedValueOnce(response(state === "COMPLETED" ? { state, result: done } : { state, result: null }))
      .mockResolvedValueOnce(response({ state: "COMPLETED", result: done }));
    const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only", instanceId: "worker-1", epoch: "1", fetch: transport,
      now: () => clock, delay: async (ms) => { clock += ms; } });
    expect(await client.invoke("task-1", request)).toEqual(done);
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(transport.mock.calls[3]![1]?.method).toBe("GET");
    if (state === "RUNNING") expect(clock).toBeGreaterThan(10000);
  });
  it("never replays execution when an unknown POST is found absent after admission expired", async () => {
    let clock = 0;
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(response(null, 404))
      .mockImplementationOnce(async () => { clock = 10000; throw new TypeError("reply lost"); })
      .mockResolvedValueOnce(response(null, 404));
    const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only", instanceId: "worker-1", epoch: "1", fetch: transport,
      now: () => clock, delay: async (ms) => { clock += ms; } });
    await expect(client.invoke("task-1", request)).rejects.toMatchObject({ code: "AI_CALL_UNKNOWN" });
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "POST", "GET"]);
  });
  it("fails closed for registered NEEDS_ATTENTION and for other GET conflicts", async () => {
    for (const refusal of [response({ state: "NEEDS_ATTENTION", result: null }), response({ code: "AI_CALL_MISMATCH" }, 409)]) {
      const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(refusal);
      await expect(harness(transport).client.invoke("task-1", request)).rejects.toBeInstanceOf(Error);
      expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
    }
  });
});

/**
 * The brief's verbatim transport-contract test: a lost POST response is followed by a GET of
 * the ORIGINAL call — the worker never invents a second authoritative request, the backend's
 * durable ledger decides. The retained ToolRequest only names what to query.
 */
it("queries the original call after a lost POST response", async () => {
  const done = { toolCallId: "call-1", workspaceRevision: "8", data: {}, truncated: false };
  const transport = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("response lost"))
    .mockResolvedValueOnce(new Response(JSON.stringify(done), { status: 200 }));
  const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
    instanceId: "worker-1", epoch: "epoch-1", fetch: transport });
  const result = await client.invoke("task-1", { toolCallId: "call-1", name: "build",
    expectedRevision: 7, args: { goal: "test" } });
  expect(result).toEqual(done);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0]![1]?.method).toBe("POST");
  expect(transport.mock.calls[1]![1]?.method).toBe("GET");
});

it("waits a bounded poll for an executing call instead of treating it as unregistered", async () => {
  const done = { toolCallId: "call-1", workspaceRevision: "8", data: { exitCode: 1 }, truncated: false };
  const running = { state: "RUNNING", result: null };
  const transport = vi.fn<typeof fetch>()
    // The POST times out while the backend keeps executing the long build.
    .mockRejectedValueOnce(new DOMException("The operation was aborted", "TimeoutError"))
    // The GET confirms the call IS registered and executing…
    .mockResolvedValueOnce(new Response(JSON.stringify(running), { status: 200 }))
    // …still executing on the next bounded poll…
    .mockResolvedValueOnce(new Response(JSON.stringify(running), { status: 200 }))
    // …and then settles with the durable answer.
    .mockResolvedValueOnce(new Response(JSON.stringify({ state: "COMPLETED", result: done }), { status: 200 }));
  const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
    instanceId: "worker-1", epoch: "epoch-1", fetch: transport, delay: async () => undefined });
  const result = await client.invoke("task-1", { toolCallId: "call-1", name: "build",
    expectedRevision: 7, args: { goal: "test" } });
  expect(result).toEqual(done);
  expect(transport.mock.calls[0]![1]?.method).toBe("POST");
  expect(transport.mock.calls[1]![1]?.method).toBe("GET");
  expect(transport).toHaveBeenCalledTimes(4);
});

it("answers a settled result carried directly by the reconciliation GET", async () => {
  const done = { toolCallId: "call-1", workspaceRevision: "8", data: {}, truncated: false };
  const transport = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("response lost"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ state: "COMPLETED", result: done }), { status: 200 }));
  const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
    instanceId: "worker-1", epoch: "epoch-1", fetch: transport });
  const result = await client.invoke("task-1", { toolCallId: "call-1", name: "write_file",
    expectedRevision: 7, args: { path: "pom.xml", content: "x", expectedSha256: null } });
  expect(result).toEqual(done);
});

it("fails closed when an executing call never settles within the bounded budget", async () => {
  const running = { state: "RUNNING", result: null };
  // A fresh Response per poll: a consumed body must not fake a refused reconciliation.
  const transport = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new DOMException("The operation was aborted", "TimeoutError"))
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(running), { status: 200 })));
  let clock = 0;
  const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
    instanceId: "worker-1", epoch: "epoch-1", fetch: transport,
    delay: async (ms: number) => { clock += ms; }, now: () => clock });
  await expect(client.invoke("task-1", { toolCallId: "call-1", name: "build",
    expectedRevision: 7, args: { goal: "test" } })).rejects.toMatchObject({ code: "AI_CALL_UNKNOWN" });
});

it("refuses to proceed when a reconciled call reads as NEEDS_ATTENTION", async () => {
  const transport = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("response lost"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ state: "NEEDS_ATTENTION", result: null }), { status: 200 }));
  const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
    instanceId: "worker-1", epoch: "epoch-1", fetch: transport });
  await expect(client.invoke("task-1", { toolCallId: "call-1", name: "build",
    expectedRevision: 7, args: { goal: "test" } })).rejects.toMatchObject({ code: "AI_CALL_NEEDS_ATTENTION" });
});

it("shrinks the terminal summary so the whole serialized payload fits the 8 KiB bound", async () => {
  // Raw bytes fit 8 KiB, but the JSON wrapper plus escaping push the payload over —
  // exactly the gap the old per-field truncation left open.
  const summary = "q\"\\\n".repeat(1400) + "tail-marker";
  const bodies: string[] = [];
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  });
  const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
    instanceId: "worker-1", epoch: "epoch-1", fetch: transport });
  const progress = new ProgressChain(client, "task-1");
  await progress.sendTerminal("COMPLETED", summary, null);
  const terminal = bodies.map((body) => JSON.parse(body) as { kind: string; text: string })
    .find((item) => item.kind === "terminal");
  expect(terminal).toBeDefined();
  expect(Buffer.byteLength(terminal!.text, "utf-8")).toBeLessThanOrEqual(8 * 1024);
  const payload = JSON.parse(terminal!.text) as { state: string; summary: string; failureCode: string | null };
  expect(payload.state).toBe("COMPLETED");
  expect(payload.failureCode).toBeNull();
  // The shrunken summary stays a prefix of the original — cut, never rewritten.
  expect(summary.startsWith(payload.summary)).toBe(true);
});

it("cuts the terminal summary on a code-point boundary, never inside a surrogate pair", async () => {
  // Filler plus emoji sized so the serialized budget boundary lands INSIDE the
  // emoji run. Whatever the cut position, the shrunken summary must never end
  // with (or contain) a lone surrogate: JSON.stringify would emit it as an
  // escape and the emoji would be corrupted at the boundary.
  const summary = "x".repeat(8100) + "😀".repeat(60) + "🏁";
  const bodies: string[] = [];
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  });
  const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
    instanceId: "worker-1", epoch: "epoch-1", fetch: transport });
  const progress = new ProgressChain(client, "task-1");
  await progress.sendTerminal("COMPLETED", summary, null);
  const terminal = bodies.map((body) => JSON.parse(body) as { kind: string; text: string })
    .find((item) => item.kind === "terminal");
  expect(terminal).toBeDefined();
  expect(Buffer.byteLength(terminal!.text, "utf-8")).toBeLessThanOrEqual(8 * 1024);
  const payload = JSON.parse(terminal!.text) as { summary: string };
  const unpairedSurrogate =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  expect(unpairedSurrogate.test(payload.summary)).toBe(false);
  // The cut stays a true prefix and keeps complete emoji at the boundary.
  expect(summary.startsWith(payload.summary)).toBe(true);
  expect(payload.summary).toContain("😀");
});

it("keeps a terminal summary that exactly fits the serialized budget", async () => {
  const bodies: string[] = [];
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  });
  const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test-only",
    instanceId: "worker-1", epoch: "epoch-1", fetch: transport });
  const progress = new ProgressChain(client, "task-1");
  const payloadBytes = (summary: string): number =>
    Buffer.byteLength(JSON.stringify({ state: "FAILED", summary, failureCode: "AI_PROVIDER_ERROR" }), "utf-8");
  // Fits exactly under the bound: multi-byte characters included, untouched.
  const fits = "ü".repeat(1000) + "word ";
  expect(payloadBytes(fits)).toBeLessThanOrEqual(8 * 1024);
  await progress.sendTerminal("FAILED", fits, "AI_PROVIDER_ERROR");
  const terminal = bodies.map((body) => JSON.parse(body) as { kind: string; text: string })
    .find((item) => item.kind === "terminal");
  expect(JSON.parse(terminal!.text)).toMatchObject({ state: "FAILED", summary: fits,
    failureCode: "AI_PROVIDER_ERROR" });
});

describe("task server", () => {
  let backendServer: ReturnType<typeof createServer>;
  let backendRequests: Array<{ method: string; url: string; body: unknown }>;
  let backendPort: number;

  const backendResponse = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  beforeEach(async () => {
    backendRequests = [];
    backendServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
      });
      req.on("end", () => {
        backendRequests.push({ method: req.method ?? "", url: req.url ?? "", body: raw === "" ? null : JSON.parse(raw) });
        if (req.url?.includes("/progress")) {
          backendResponse(res, 200, { accepted: true });
        } else {
          backendResponse(res, 200, {
            toolCallId: "call-1", workspaceRevision: "8", data: {}, truncated: false,
          });
        }
      });
    });
    await new Promise<void>((resolve) => backendServer.listen(0, "127.0.0.1", resolve));
    backendPort = (backendServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      backendServer.close((error) => (error ? reject(error) : resolve())));
  });

  function workerConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
    return {
      port: 0,
      workerToken: "worker-token",
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      backendToken: "backend-token",
      instanceId: "worker-1",
      bootId: "boot-test",
      model: null,
      paths: { scratchDir: ".", agentDir: ".", sessionDir: "." },
      budgets: { wallClockSeconds: 1800, toolCalls: 60, builds: 8 },
      ...overrides,
    };
  }

  function startBody(taskId: string, epoch = 1): Record<string, unknown> {
    return {
      taskId,
      prompt: "fix the build",
      workspaceRevision: "7",
      requestSha256: "a".repeat(64),
      workerEpoch: epoch,
      reasoningEffort: "high",
    };
  }

  const TEST_MODEL = { provider: "deepseek", apiType: "openai-completions", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "k" };
  it.each([undefined, null, "medium", 1, ["max"]].map(reasoningEffort => ({ reasoningEffort })))("refuses invalid persisted effort $reasoningEffort before creating a runner", async ({ reasoningEffort }) => {
    let created = 0;
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), { createRunner: () => { created++; return stubRunner(); } });
    const port = await handle.listen();
    try {
      expect((await post(`http://127.0.0.1:${port}/tasks/task/start`, { ...startBody("task"), reasoningEffort })).status).toBe(422);
      expect(created).toBe(0);
    } finally { await handle.close(); }
  });

  it("rejects unsupported reasoning before creating a runner and validates persisted effort", async () => {
    let created = 0;
    const handle = createTaskServer(workerConfig({ model: { ...TEST_MODEL, provider: "other", baseUrl: "https://other.invalid" } }), { createRunner: () => { created++; return stubRunner(); } });
    const port = await handle.listen();
    try {
      const response = await post(`http://127.0.0.1:${port}/tasks/task/start`, startBody("task"));
      expect(response.status).toBe(422); expect(await response.json()).toEqual({ error: "AI_REASONING_UNSUPPORTED" });
      expect(created).toBe(0);
    } finally { await handle.close(); }
  });

  it("carries a validated conversation identity to the runner while preserving legacy null starts", async () => {
    const starts: Array<string | null | undefined> = [];
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), {
      createRunner: (deps) => { starts.push(deps.start.conversationId); return stubRunner(); },
    });
    const port = await handle.listen();
    try {
      const conversationId = "00000000-0000-4000-8000-000000000001";
      expect((await post(`http://127.0.0.1:${port}/tasks/first/start`, { ...startBody("first"), conversationId })).status).toBe(200);
      await vi.waitFor(() => expect(handle.activeTaskId()).toBeNull());
      expect((await post(`http://127.0.0.1:${port}/tasks/legacy/start`, { ...startBody("legacy"), conversationId: null })).status).toBe(200);
      await vi.waitFor(() => expect(handle.activeTaskId()).toBeNull());
      expect((await post(`http://127.0.0.1:${port}/tasks/invalid/start`, { ...startBody("invalid"), conversationId: "not-a-conversation" })).status).toBe(422);
      expect(starts).toEqual([conversationId, null]);
    } finally { await handle.close(); }
  });

  it("answers a replayed start for the same task once without a second runner", async () => {
    let created = 0;
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), {
      createRunner: () => {
        created++;
        return stubRunner();
      },
    } as never);
    const port = await handle.listen();
    try {
      const first = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"));
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const replay = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"));
      expect(replay.status).toBe(200);
      const replayBody = await replay.json();
      expect(created).toBe(1);
      expect(replayBody).toEqual(firstBody);
      expect(firstBody.instanceId).toBe("worker-1");
    } finally {
      await handle.close();
    }
  });

  it("refuses a start with a fixed 503 before any runner exists while the model is unconfigured", async () => {
    let created = 0;
    const handle = createTaskServer(workerConfig({ model: null }), {
      createRunner: () => {
        created++;
        return stubRunner();
      },
    } as never);
    const port = await handle.listen();
    try {
      const refused = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"));
      expect(refused.status).toBe(503);
      const body = await refused.json();
      expect(body["error"]).toBe("AI_WORKER_NOT_CONFIGURED");
      expect(created).toBe(0);
      // Once configured, the same start is accepted.
      const configured = createTaskServer(workerConfig({ model: TEST_MODEL }), {
        createRunner: () => { created++; return stubRunner(); },
      } as never);
      const port2 = await configured.listen();
      try {
        const accepted = await post(`http://127.0.0.1:${port2}/tasks/task-1/start`, startBody("task-1"));
        expect(accepted.status).toBe(200);
        expect(created).toBe(1);
      } finally {
        await configured.close();
      }
    } finally {
      await handle.close();
    }
  });

  it("refuses a start whose epoch differs from the running task instead of adopting it", async () => {
    const created: string[] = [];
    let firstRunnerStop = 0;
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), {
      createRunner: (deps) => {
        created.push(`${deps.start.taskId}:${deps.start.workerEpoch}`);
        return {
          taskId: deps.taskId,
          state: () => "RUNNING",
          start: () => new Promise<void>(() => { }), // stays RUNNING
          stop: async () => {
            firstRunnerStop++;
          },
        };
      },
    } as never);
    const port = await handle.listen();
    try {
      const first = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1", 1));
      expect(first.status).toBe(200);
      // The epoch is persisted exactly once at creation and is never re-fenced
      // (review fix I2): a start with a DIFFERENT epoch for a still-running task is
      // a fencing violation — refused with 409, never adopted, never restarted, so
      // two sessions can never overlap one task.
      const refenced = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1", 2));
      expect(refenced.status).toBe(409);
      expect(created).toEqual(["task-1:1"]);
      expect(firstRunnerStop).toBe(0);
      // The same epoch stays idempotent.
      const sameEpoch = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1", 1));
      expect(sameEpoch.status).toBe(200);
      expect(created).toEqual(["task-1:1"]);
    } finally {
      await handle.close();
    }
  });

  it.each(["AI_WORKER_ERROR", "AI_CONTEXT_UNAVAILABLE"])("reports %s through the terminal delivery when the runner fails before settling", async (failureCode) => {
    backendServer.removeAllListeners("request");
    const progressBodies: Array<Record<string, unknown>> = [];
    const terminalBodies: Array<Record<string, unknown>> = [];
    backendServer.on("request", canonicalTerminalHandler(terminalBodies, (body) => progressBodies.push(body)));
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), {
      createRunner: () => ({
        taskId: "task-1",
        state: () => "RUNNING",
        start: async () => {
          if (failureCode === "AI_CONTEXT_UNAVAILABLE") throw new BackendHttpError(0, failureCode, "history unavailable");
          throw new Error("boom before any session existed");
        },
        stop: async () => undefined,
      }),
    } as never);
    const port = await handle.listen();
    try {
      const started = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"));
      expect(started.status).toBe(200);
      // The failure must reach the backend as a durable terminal REPORT on the receipt
      // route — never as a progress item and never as a second execution outcome.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && terminalBodies.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(progressBodies.filter((body) => body["kind"] === "terminal")).toEqual([]);
      const expectedReportId = terminalReportId("task-1", 1, "a".repeat(64));
      expect(terminalBodies[0]).toMatchObject({
        protocolVersion: 1,
        reportId: expectedReportId,
        state: "FAILED",
        failureCode,
      });
      // Once the backend confirmed the receipt, the execution slot is released.
      await vi.waitFor(() => expect(handle.activeTaskId()).toBeNull());
    } finally {
      await handle.close();
    }
  });

  it("holds the slot while the delivery is unconfirmed and never sends a second FAILED outcome", async () => {
    backendServer.removeAllListeners("request");
    const terminalBodies: string[] = [];
    backendServer.on("request", (req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
      });
      req.on("end", () => {
        if (req.method === "POST" && req.url?.endsWith("/terminal")) {
          terminalBodies.push(raw);
          backendResponse(res, 500, { code: "AI_TERMINAL_REJECTED", message: "backend unavailable" });
          return;
        }
        if (req.url?.includes("/progress")) {
          backendResponse(res, 200, { accepted: true });
          return;
        }
        backendResponse(res, 200, { toolCallId: "call-1", workspaceRevision: "8", data: {}, truncated: false });
      });
    });
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), {
      createRunner: (deps) => ({
        taskId: deps.taskId,
        state: () => "RUNNING",
        start: async () => {
          // The outcome freezes first; a failure AFTER the freeze (a delivery or late
          // execution error) must never create a second, overriding FAILED outcome.
          deps.settle({ state: "COMPLETED", summary: "done", failureCode: null, reason: "the model finished" });
          throw new Error("late failure after the frozen outcome");
        },
        stop: async () => undefined,
      }),
    } as never);
    const port = await handle.listen();
    try {
      expect((await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"))).status).toBe(200);
      // At least two identical push attempts were made against the failing backend.
      await vi.waitFor(() => expect(terminalBodies.length).toBeGreaterThanOrEqual(2));
      expect(new Set(terminalBodies)).toHaveLength(1);
      expect(JSON.parse(terminalBodies[0]!)).toMatchObject({ protocolVersion: 1, state: "COMPLETED", failureCode: null });
      const status = await (await fetch(`http://127.0.0.1:${port}/tasks/task-1`, {
        headers: { "x-manao-worker-token": "worker-token" },
      })).json();
      expect(status).toMatchObject({
        state: "COMPLETED",
        executionState: "COMPLETED",
        terminalDelivery: { state: "PENDING", reportId: terminalReportId("task-1", 1, "a".repeat(64)) },
      });
      // PENDING keeps the execution slot: a new model task is refused, but stop and GET
      // still answer.
      expect((await post(`http://127.0.0.1:${port}/tasks/task-2/start`, startBody("task-2"))).status).toBe(409);
      expect(handle.activeTaskId()).toBe("task-1");
      expect((await post(`http://127.0.0.1:${port}/tasks/task-1/stop`, {})).status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("releases the slot and reports the full protocol status after the terminal ack", async () => {
    backendServer.removeAllListeners("request");
    const terminalBodies: Array<Record<string, unknown>> = [];
    backendServer.on("request", canonicalTerminalHandler(terminalBodies));
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), {
      createRunner: (deps) => ({
        taskId: deps.taskId,
        state: () => "RUNNING",
        start: async () => {
          deps.settle({ state: "COMPLETED", summary: "完成", failureCode: null, reason: "the model finished" });
        },
        stop: async () => undefined,
      }),
    } as never);
    const port = await handle.listen();
    try {
      expect((await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"))).status).toBe(200);
      await vi.waitFor(() => expect(handle.activeTaskId()).toBeNull());
      const expectedReportId = terminalReportId("task-1", 1, "a".repeat(64));
      const status = await (await fetch(`http://127.0.0.1:${port}/tasks/task-1`, {
        headers: { "x-manao-worker-token": "worker-token" },
      })).json();
      expect(status).toEqual({
        taskId: "task-1",
        instanceId: "worker-1",
        state: "COMPLETED",
        protocolVersion: 1,
        workerEpoch: 1,
        requestSha256: "a".repeat(64),
        executionState: "COMPLETED",
        terminalDelivery: {
          state: "ACKED",
          reportId: expectedReportId,
          reportSha256: terminalContentSha256(expectedReportId, "COMPLETED", "完成", null),
          report: { protocolVersion: 1, reportId: expectedReportId, state: "COMPLETED", summary: "完成", failureCode: null },
        },
      });
      // The confirmed slot is free: another task starts, and the settled task replay
      // stays idempotent.
      expect((await post(`http://127.0.0.1:${port}/tasks/task-2/start`, startBody("task-2"))).status).toBe(200);
      expect((await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"))).status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("reports STOPPING as the execution state once abort is requested", async () => {
    let stopCalled = 0;
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), {
      createRunner: () => ({
        taskId: "task-1",
        state: () => (stopCalled > 0 ? "STOPPING" : "RUNNING"),
        start: () => new Promise<void>(() => { }),
        stop: async () => { stopCalled += 1; },
      }),
    } as never);
    const port = await handle.listen();
    try {
      expect((await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"))).status).toBe(200);
      const running = await (await fetch(`http://127.0.0.1:${port}/tasks/task-1`, {
        headers: { "x-manao-worker-token": "worker-token" },
      })).json();
      expect(running).toMatchObject({ state: "RUNNING", executionState: "RUNNING" });
      expect((await post(`http://127.0.0.1:${port}/tasks/task-1/stop`, {})).status).toBe(200);
      const stopping = await (await fetch(`http://127.0.0.1:${port}/tasks/task-1`, {
        headers: { "x-manao-worker-token": "worker-token" },
      })).json();
      expect(stopping).toMatchObject({ state: "STOPPING", executionState: "STOPPING" });
    } finally {
      await handle.close();
    }
  });

  it("answers GET /status with the boot identity and slot without secrets", async () => {
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), {
      createRunner: () => ({
        taskId: "task-1",
        state: () => "RUNNING",
        start: () => new Promise<void>(() => { }),
        stop: async () => undefined,
      }),
    } as never);
    const port = await handle.listen();
    const statusHeaders = { "x-manao-worker-token": "worker-token" };
    try {
      expect((await fetch(`http://127.0.0.1:${port}/status`)).status).toBe(401);
      const idle = await (await fetch(`http://127.0.0.1:${port}/status`, { headers: statusHeaders })).json();
      expect(idle).toEqual({
        bootId: "boot-test",
        instanceId: "worker-1",
        activeTaskId: null,
        activeExecutionState: null,
        activeKind: null,
        modelConfigured: true,
      });
      expect((await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"))).status).toBe(200);
      const busy = await (await fetch(`http://127.0.0.1:${port}/status`, { headers: statusHeaders })).json();
      expect(busy).toMatchObject({ activeTaskId: "task-1", activeExecutionState: "RUNNING", activeKind: "task" });
      // Diagnostics never carry the prompt or any credential.
      const rendered = JSON.stringify(busy);
      expect(rendered).not.toContain("fix the build");
      expect(rendered).not.toContain("backend-token");
    } finally {
      await handle.close();
    }
  });

  it("applies a stop requested during session init and never prompts afterwards", async () => {
    backendServer.removeAllListeners("request");
    const progressBodies: Array<Record<string, unknown>> = [];
    const terminalBodies: Array<Record<string, unknown>> = [];
    backendServer.on("request", canonicalTerminalHandler(terminalBodies, (body) => progressBodies.push(body)));
    let releaseSession!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSession = resolve; });
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL, paths: privateDirs() }), {
      // The REAL default runner drives this test: createPiSession is held mid-init.
      createManualSession: async (options) => {
        await gate;
        return scriptedSessionFactory([{ text: "must never be generated" }])(options);
      },
    });
    const port = await handle.listen();
    try {
      expect((await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"))).status).toBe(200);
      expect((await post(`http://127.0.0.1:${port}/tasks/task-1/stop`, {})).status).toBe(200);
      releaseSession();
      // The run settles cancelled — FAILED/AI_ABORTED — without any prompt round, and
      // the frozen outcome goes out through the terminal delivery.
      await vi.waitFor(() => expect(terminalBodies.length).toBeGreaterThan(0));
      expect(terminalBodies[0]).toMatchObject({ state: "FAILED", failureCode: "AI_ABORTED" });
      expect(progressBodies.filter((body) => body["kind"] === "message")).toEqual([]);
      await vi.waitFor(() => expect(handle.activeTaskId()).toBeNull());
    } finally {
      await handle.close();
    }
  });

  it("refuses a second task while one is running with 409", async () => {
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), {
      // A runner whose start never settles models a task that stays RUNNING.
      createRunner: () => ({
        taskId: "task-1",
        state: () => "RUNNING",
        start: () => new Promise<void>(() => { }),
        stop: async () => undefined,
      }),
    } as never);
    const port = await handle.listen();
    try {
      const first = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"));
      expect(first.status).toBe(200);
      const second = await post(`http://127.0.0.1:${port}/tasks/task-2/start`, startBody("task-2"));
      expect(second.status).toBe(409);
    } finally {
      await handle.close();
    }
  });

  it("refuses requests without the worker token", async () => {
    const handle = createTaskServer(workerConfig(), { createRunner: () => stubRunner() } as never);
    const port = await handle.listen();
    try {
      const anonymous = await fetch(`http://127.0.0.1:${port}/tasks/task-1/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(startBody("task-1")),
      });
      expect(anonymous.status).toBe(401);
      const wrong = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"), "wrong-token");
      expect(wrong.status).toBe(401);
      expect(backendRequests).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it("replays the current item when a gap answer names its own seq", async () => {
    // The backend persisted nothing yet but answers expectedSeq: 1 — the equality
    // branch must retry the CURRENT item instead of silently dropping it.
    backendServer.removeAllListeners("request");
    const progressBodies: Array<Record<string, unknown>> = [];
    backendServer.on("request", (req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
      });
      req.on("end", () => {
        if (req.url?.includes("/progress")) {
          progressBodies.push(JSON.parse(raw));
          if (progressBodies.length === 1) {
            backendResponse(res, 409, { code: "AI_PROGRESS_GAP", expectedSeq: 1 });
            return;
          }
          backendResponse(res, 200, { accepted: true });
          return;
        }
        backendResponse(res, 200, { toolCallId: "call-1", workspaceRevision: "8", data: {}, truncated: false });
      });
    });

    const client = new BackendClient({
      baseUrl: `http://127.0.0.1:${backendPort}`,
      token: "backend-token",
      instanceId: "worker-1",
      epoch: "1",
    });
    const chain = new ProgressChain(client, "task-1");
    chain.send("message", "the only full message");
    await chain.drain();
    expect(progressBodies.length).toBe(2);
    expect(progressBodies[0]).toEqual(progressBodies[1]);
    expect(progressBodies[0]).toEqual({ seq: 1, kind: "message", text: "the only full message", truncated: false });
  });

  it("retransmits a lost progress response with the same seq and identical payload", async () => {
    // The fake backend drops the first progress POST's response after reading it.
    backendServer.removeAllListeners("request");
    const progressBodies: Array<Record<string, unknown>> = [];
    backendServer.on("request", (req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
      });
      req.on("end", () => {
        if (req.url?.includes("/progress")) {
          progressBodies.push(JSON.parse(raw));
          if (progressBodies.length === 1) {
            req.socket.destroy(); // response lost
            return;
          }
          backendResponse(res, 200, { accepted: true });
          return;
        }
        backendResponse(res, 200, { toolCallId: "call-1", workspaceRevision: "8", data: {}, truncated: false });
      });
    });

    const client = new BackendClient({
      baseUrl: `http://127.0.0.1:${backendPort}`,
      token: "backend-token",
      instanceId: "worker-1",
      epoch: "1",
    });
    const chain = new ProgressChain(client, "task-1");
    chain.send("message", "first full message");
    chain.send("message", "second full message");
    await chain.drain();
    expect(progressBodies.length).toBeGreaterThanOrEqual(2);
    // The retransmission repeats the SAME seq with byte-identical payload — never a new seq.
    const firstSeq = progressBodies[0]!["seq"];
    expect(progressBodies[0]).toEqual({ seq: firstSeq, kind: "message", text: "first full message", truncated: false });
    expect(progressBodies[1]).toEqual(progressBodies[0]);
    expect(progressBodies.at(-1)).toEqual({ seq: firstSeq! + 1, kind: "message", text: "second full message", truncated: false });
  });
});

describe("worker boot identity", () => {
  const env = {
    MANAO_AI_WORKER_TOKEN: "worker-test-token",
    MANAO_AI_BACKEND_TOKEN: "backend-test-token",
    MANAO_AI_BACKEND_BASE_URL: "http://127.0.0.1:9",
    MANAO_AI_SCRATCH_DIR: ".",
    MANAO_AI_AGENT_DIR: ".",
    MANAO_AI_SESSION_DIR: ".",
  };
  it("never reuses a fixed instance string across process boots", () => {
    const first = loadWorkerConfig({ ...env, MANAO_AI_INSTANCE_ID: "pi-worker-stage1" });
    const second = loadWorkerConfig({ ...env, MANAO_AI_INSTANCE_ID: "pi-worker-stage1" });
    // The configured value is only a prefix: every boot identity embeds a fresh bootId,
    // so a restarted process can never answer under the dead process's identity.
    expect(first.bootId).not.toBe(second.bootId);
    expect(first.instanceId).toBe(`pi-worker-stage1-${first.bootId}`);
    expect(second.instanceId).toBe(`pi-worker-stage1-${second.bootId}`);
    expect(first.instanceId.length).toBeLessThanOrEqual(64); // fits worker_instance_id VARCHAR(64)
  });
  it("prefixes the boot identity with pi-worker without an instance override", () => {
    const config = loadWorkerConfig(env);
    expect(config.instanceId).toBe(`pi-worker-${config.bootId}`);
  });
});

function stubRunner() {
  return {
    taskId: "task-1",
    state: () => "RUNNING",
    start: async () => undefined,
    stop: async () => undefined,
  };
}

async function post(url: string, body: unknown, token = "worker-token"): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-manao-worker-token": token },
    body: JSON.stringify(body),
  });
}
