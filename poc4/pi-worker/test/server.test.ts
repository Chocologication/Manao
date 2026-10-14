import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendClient, ProgressChain } from "../src/backend-client.js";
import { createTaskServer, type WorkerConfig } from "../src/server.js";

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
    };
  }

  const TEST_MODEL = { provider: "p", apiType: "openai-completions", baseUrl: "http://127.0.0.1:9", model: "m", apiKey: "k" };

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

  it("adopts a re-fenced epoch for the same task by restarting the run", async () => {
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
      // The same task, same request, a NEW epoch: the backend re-fenced, so the worker
      // restarts under the adopted epoch instead of answering from the stale session.
      const refenced = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1", 2));
      expect(refenced.status).toBe(200);
      expect(created).toEqual(["task-1:1", "task-1:2"]);
      expect(firstRunnerStop).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("reports a terminal through the progress chain when the runner fails before settling", async () => {
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
          backendResponse(res, 200, { accepted: true });
          return;
        }
        backendResponse(res, 200, { toolCallId: "call-1", workspaceRevision: "8", data: {}, truncated: false });
      });
    });
    const handle = createTaskServer(workerConfig({ model: TEST_MODEL }), {
      createRunner: () => ({
        taskId: "task-1",
        state: () => "RUNNING",
        start: async () => {
          throw new Error("boom before any session existed");
        },
        stop: async () => undefined,
      }),
    } as never);
    const port = await handle.listen();
    try {
      const started = await post(`http://127.0.0.1:${port}/tasks/task-1/start`, startBody("task-1"));
      expect(started.status).toBe(200);
      // The failure must reach the backend as a terminal state, never leave the task stuck.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !progressBodies.some((body) => body["kind"] === "terminal")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const terminal = progressBodies.find((body) => body["kind"] === "terminal");
      expect(terminal).toBeDefined();
      expect(JSON.parse(terminal!["text"] as string)).toMatchObject({
        state: "FAILED", failureCode: "AI_WORKER_ERROR",
      });
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
