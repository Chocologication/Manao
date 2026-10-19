/**
 * The worker's task HTTP surface (stage one): Node's built-in http module, three
 * routes, no framework. POST /tasks/{taskId}/start accepts immediately and drives
 * the SDK session asynchronously; a replayed identical start is idempotent, a
 * different epoch for a known task is refused (the epoch is persisted exactly once
 * at creation — review fix I2), and a second task is refused with 409 while one is
 * running; GET /tasks/{taskId} serves the reconciliation path for a lost start
 * response; POST /tasks/{taskId}/stop aborts the SDK session — occupancy is only
 * ever released by the backend's close flow, never by this worker's own abort
 * result. Every route fails closed without the worker token.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { BackendClient, BackendHttpError, ProgressChain } from "./backend-client.js";
import { ConfigError, loadWorkerConfig, modelConfigProblems, type WorkerConfig } from "./config.js";
import { compactIdleConversation, createPiSession, type PiSessionDeps, type PiTaskOutcome, type PiTaskSession } from "./pi-session.js";
import type { CompactStart, CompactResult } from "./conversation-context.js";

export interface WorkerStartBody {
  taskId: string;
  prompt: string;
  workspaceRevision: string;
  requestSha256: string;
  workerEpoch: number;
  reasoningEffort: "off" | "low" | "high" | "max";
  conversationId?: string | null;
}

export interface TaskRunner {
  readonly taskId: string;
  state(): string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RunnerDeps {
  readonly taskId: string;
  readonly start: WorkerStartBody;
  readonly backend: BackendClient;
  readonly progress: ProgressChain;
}

export interface ServerDeps {
  /** Overrides runner creation (tests stub the session; production drives Pi). */
  createRunner?: (deps: RunnerDeps) => TaskRunner;
  createManualSession?: PiSessionDeps["createSession"];
  now?: () => number;
}

interface TaskRecord {
  readonly start: WorkerStartBody;
  readonly runner: TaskRunner;
  readonly progress: ProgressChain;
  /** The worker-reported terminal outcome, kept for reconciliation GETs. */
  outcome: PiTaskOutcome | null;
}

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type ActiveWork = { kind: "task"; taskId: string } | { kind: "compact"; conversationId: string; requestId: string };
interface CompactRecord { start: CompactStart; backend: BackendClient; result: CompactResult | null; confirmed: boolean; rejected: boolean; delivery: Promise<void> | null }
const MAX_BODY_BYTES = 64 * 1024;

export interface TaskServerHandle {
  server: Server;
  listen(): Promise<number>;
  close(): Promise<void>;
  /** The single active task id, if any (test/diagnostics seam). */
  activeTaskId(): string | null;
}

export function createTaskServer(config: WorkerConfig, deps: ServerDeps = {}): TaskServerHandle {
  const tasks = new Map<string, TaskRecord>();
  const compactions = new Map<string, CompactRecord>();
  let active: ActiveWork | null = null;
  const tokenDigest = config.workerToken === "" ? null : sha256(config.workerToken);

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, { error: "internal error" });
      } else {
        response.end();
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (tokenDigest === null || !tokenMatches(request, tokenDigest)) {
      // Fail closed: without a configured token every route is refused.
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const compactStart = /^\/conversations\/([a-f0-9-]+)\/compact$/.exec(url.pathname);
    const compactGet = /^\/conversations\/([a-f0-9-]+)\/compactions\/([a-f0-9-]+)$/.exec(url.pathname);
    if (request.method === "POST" && compactStart !== null) { await handleCompactStart(compactStart[1]!, request, response); return; }
    if (request.method === "GET" && compactGet !== null) {
      const conversationId = compactGet[1]!; const requestId = compactGet[2]!;
      const record = compactions.get(`${conversationId}/${requestId}`);
      if (record) void deliverCompaction(record);
      writeJson(response, 200, compactStatus(conversationId, requestId, record)); return;
    }
    const startMatch = /^\/tasks\/([A-Za-z0-9-]+)\/start$/.exec(url.pathname);
    const stopMatch = /^\/tasks\/([A-Za-z0-9-]+)\/stop$/.exec(url.pathname);
    const getMatch = /^\/tasks\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (request.method === "POST" && startMatch !== null) {
      await handleStart(startMatch[1]!, request, response);
      return;
    }
    if (request.method === "POST" && stopMatch !== null) {
      await handleStop(stopMatch[1]!, response);
      return;
    }
    if (request.method === "GET" && getMatch !== null) {
      handleGet(getMatch[1]!, response);
      return;
    }
    writeJson(response, 404, { error: "not found" });
  }

  async function handleStart(taskId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    if (body === null) {
      writeJson(response, 422, { error: "request body must be JSON" });
      return;
    }
    const start = validateStart(taskId, body);
    if (typeof start === "string") {
      writeJson(response, 422, { error: start });
      return;
    }
    // The model gate answers BEFORE any runner or session exists: a worker without a
    // complete model configuration refuses every start with a fixed 503, which the
    // backend turns into an explicit pre-start task failure.
    if (modelConfigProblems(config.model).length > 0) {
      writeJson(response, 503, { error: "AI_WORKER_NOT_CONFIGURED" });
      return;
    }
    const existing = tasks.get(taskId);
    if (existing !== undefined) {
      if (existing.start.requestSha256 !== start.requestSha256) {
        writeJson(response, 409, { error: "task id was already used for a different request" });
        return;
      }
      if (existing.start.workerEpoch !== start.workerEpoch) {
        // The fencing epoch is persisted exactly once at creation (review fix I2) and
        // is never re-fenced, so a DIFFERENT epoch for a known task is a fencing
        // violation: refuse it instead of adopting a second session — two sessions
        // must never overlap one task, and a settled task never restarts.
        writeJson(response, 409, { error: "the worker epoch does not match the task" });
        return;
      }
      // Same task, same request, same fencing: idempotent. A settled task
      // answers its settled state; a still-running task is never started twice.
      writeJson(response, 200, statusOf(taskId));
      return;
    }
    if (active !== null) {
      writeJson(response, 409, { error: "the worker already runs another task" });
      return;
    }
    let deepSeek = false;
    try { deepSeek = new URL(config.model!.baseUrl).hostname === "api.deepseek.com"
      && ["openai", "openai-completions"].includes(config.model!.apiType); } catch { /* Refuse unsupported server configuration. */ }
    if (!deepSeek) { writeJson(response, 422, { error: "AI_REASONING_UNSUPPORTED" }); return; }
    const record = createRecord(start);
    tasks.set(taskId, record);
    active = { kind: "task", taskId };
    // Accept immediately; the session prompt runs asynchronously below.
    writeJson(response, 200, statusOf(taskId));
    launch(record);
  }

  function createRecord(start: WorkerStartBody): TaskRecord {
    const backend = new BackendClient({
      baseUrl: config.backendBaseUrl,
      token: config.backendToken,
      instanceId: config.instanceId,
      epoch: start.workerEpoch,
    });
    const progress = new ProgressChain(backend, start.taskId);
    const createRunner = deps.createRunner ?? defaultRunner;
    const runner = createRunner({ taskId: start.taskId, start, backend, progress });
    return { start, runner, progress, outcome: null };
  }

  function launch(record: TaskRecord): void {
    void record.runner.start()
      .catch((error: unknown) => {
        // The runner failing before it could settle must leave a trace: this path
        // is the last line of defense and its error is otherwise invisible (the
        // stage-one acceptance hit exactly that silence on 2026-10-15).
        console.error(`[task ${record.start.taskId}] runner failed before settling:`,
          error instanceof Error ? `${error.name}: ${error.message}` : error);
        const failureCode = error instanceof BackendHttpError && error.code === "AI_CONTEXT_UNAVAILABLE"
          ? "AI_CONTEXT_UNAVAILABLE" : "AI_WORKER_ERROR";
        record.outcome = { state: "FAILED", summary: "", failureCode, reason: "the task runner failed before it could settle" };
        // Even a failure before any session existed must reach the backend as a
        // terminal state through the same serialized progress chain.
        void record.progress.sendTerminal("FAILED", "", failureCode);
      })
      .finally(() => {
        if (active?.kind === "task" && active.taskId === record.start.taskId) {
          active = null;
        }
      });
  }

  async function handleCompactStart(conversationId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readJson(request);
    const body = raw as Partial<CompactStart> | null;
    if (!body || body.conversationId !== conversationId || !UUID.test(conversationId) || typeof body.requestId !== "string"
      || !UUID.test(body.requestId) || !Number.isSafeInteger(body.expectedHeadSeq) || body.expectedHeadSeq! < 0) {
      writeJson(response, 422, { error: "Invalid compaction identity" }); return;
    }
    const start = body as CompactStart;
    const key = `${conversationId}/${start.requestId}`;
    const existing = compactions.get(key);
    if (existing) {
      if (existing.start.expectedHeadSeq !== start.expectedHeadSeq) { writeJson(response, 409, { error: "Compaction identity mismatch" }); return; }
      writeJson(response, 200, compactStatus(conversationId, start.requestId, existing)); return;
    }
    if (modelConfigProblems(config.model).length > 0) { writeJson(response, 503, { error: "AI_WORKER_NOT_CONFIGURED" }); return; }
    if (active !== null) { writeJson(response, 409, { error: "The worker is busy" }); return; }
    const backend = new BackendClient({ baseUrl: config.backendBaseUrl, token: config.backendToken, instanceId: config.instanceId, epoch: 0 });
    const record: CompactRecord = { start, backend, result: null, confirmed: false, rejected: false, delivery: null };
    compactions.set(key, record);
    active = { kind: "compact", conversationId, requestId: start.requestId };
    writeJson(response, 200, compactStatus(conversationId, start.requestId, record));
    void compactIdleConversation({ model: config.model!, paths: config.paths, backend, start, createSession: deps.createManualSession })
      .then(result => { record.result = result; })
      .catch(() => { record.result = { expectedHeadSeq: start.expectedHeadSeq, entries: [], usage: null, failureCode: "AI_CONTEXT_COMPACTION_FAILED" }; })
      .then(async () => {
        // SDK work has stopped. Result delivery holds no execution slot or project write authority.
        if (active?.kind === "compact" && active.conversationId === conversationId && active.requestId === start.requestId) active = null;
        await deliverCompaction(record);
      });
  }

  function compactStatus(conversationId: string, requestId: string, record?: CompactRecord) {
    return { conversationId, requestId, instanceId: config.instanceId,
      state: !record ? "NOT_FOUND" : !record.confirmed ? "RUNNING" : record.rejected || record.result?.failureCode ? "FAILED" : "COMPLETED" };
  }
  async function deliverCompaction(record: CompactRecord): Promise<void> {
    if (!record.result || record.confirmed) return;
    if (record.delivery) return record.delivery;
    record.delivery = record.backend.finishCompaction(record.start, record.result).then(() => { record.confirmed = true; })
      .catch(error => { if (error instanceof BackendHttpError && error.status === 409) { record.confirmed = true; record.rejected = true; } })
      .finally(() => { record.delivery = null; });
    return record.delivery;
  }

  const defaultRunner = (runnerDeps: RunnerDeps): TaskRunner => {
    // The model gate already refused unconfigured starts in handleStart; this remains
    // as defense in depth for a record created before the gate.
    if (config.model === null || modelConfigProblems(config.model).length > 0) {
      throw new WorkerStartRefusedError("the worker has no model configuration");
    }
    let session: PiTaskSession | null = null;
    let stopped = false;
    return {
      taskId: runnerDeps.taskId,
      state: () => session === null ? "RUNNING" : stopped ? "STOPPING" : "RUNNING",
      async start(): Promise<void> {
        session = await createPiSession({
          model: config.model!,
          paths: config.paths,
          budgets: config.budgets,
          backend: runnerDeps.backend,
          progress: runnerDeps.progress,
          taskId: runnerDeps.taskId,
          startRevision: runnerDeps.start.workspaceRevision,
          conversationId: runnerDeps.start.conversationId,
          reasoningEffort: runnerDeps.start.reasoningEffort,
        });
        const runningSession = session;
        let outcome: PiTaskOutcome;
        try { outcome = await runningSession.run({
          prompt: runnerDeps.start.prompt,
          workspaceRevision: runnerDeps.start.workspaceRevision,
        }); } catch (error) { runningSession.dispose(); throw error; }
        const record = tasks.get(runnerDeps.taskId);
        if (record !== undefined) {
          record.outcome = outcome;
        }
      },
      async stop(): Promise<void> {
        stopped = true;
        session?.stop();
      },
    };
  };

  async function handleStop(taskId: string, response: ServerResponse): Promise<void> {
    const record = tasks.get(taskId);
    if (record === undefined) {
      writeJson(response, 404, { error: "task not found" });
      return;
    }
    try {
      await record.runner.stop();
    } catch {
      // The abort result alone never changes the backend's occupancy decision.
    }
    writeJson(response, 200, statusOf(taskId));
  }

  function handleGet(taskId: string, response: ServerResponse): void {
    if (!tasks.has(taskId)) {
      writeJson(response, 404, { error: "task not found" });
      return;
    }
    writeJson(response, 200, statusOf(taskId));
  }

  function statusOf(taskId: string): { taskId: string; instanceId: string; state: string } {
    const record = tasks.get(taskId)!;
    const outcome = record.outcome;
    const state = outcome !== null ? outcome.state : record.runner.state();
    return { taskId, instanceId: config.instanceId, state };
  }

  function validateStart(taskId: string, body: unknown): WorkerStartBody | string {
    if (typeof body !== "object" || body === null) {
      return "request body must be an object";
    }
    const candidate = body as Record<string, unknown>;
    if (candidate["taskId"] !== taskId) {
      return "taskId must match the URL path";
    }
    if (typeof candidate["prompt"] !== "string" || candidate["prompt"].trim() === "") {
      return "prompt is required";
    }
    if (typeof candidate["workspaceRevision"] !== "string") {
      return "workspaceRevision is required";
    }
    if (!["off", "low", "high", "max"].includes(String(candidate["reasoningEffort"]))) return "reasoningEffort must be a supported persisted value";
    if (typeof candidate["requestSha256"] !== "string" || !SHA256.test(candidate["requestSha256"])) {
      return "requestSha256 must be a sha-256 hex digest";
    }
    if (typeof candidate["workerEpoch"] !== "number" || !Number.isInteger(candidate["workerEpoch"]) || candidate["workerEpoch"] < 0) {
      return "workerEpoch must be a non-negative integer";
    }
    if (candidate["conversationId"] !== undefined && candidate["conversationId"] !== null
      && (typeof candidate["conversationId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate["conversationId"]))) {
      return "conversationId must be a UUID or null";
    }
    return {
      taskId,
      prompt: candidate["prompt"],
      workspaceRevision: candidate["workspaceRevision"],
      requestSha256: candidate["requestSha256"],
      workerEpoch: candidate["workerEpoch"],
      reasoningEffort: candidate["reasoningEffort"] as WorkerStartBody["reasoningEffort"],
      conversationId: candidate["conversationId"] as string | null | undefined,
    };
  }

  const serverHandle: TaskServerHandle = {
    server,
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, "0.0.0.0", () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : config.port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))));
    },
    activeTaskId: () => active?.kind === "task" ? active.taskId : null,
  };
  return serverHandle;
}

class WorkerStartRefusedError extends Error { }

function tokenMatches(request: IncomingMessage, digest: Buffer): boolean {
  const header = request.headers["x-manao-worker-token"];
  if (typeof header !== "string" || header === "") {
    return false;
  }
  const candidate = sha256(header);
  return candidate.length === digest.length && timingSafeEqual(candidate, digest);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf-8").digest();
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve) => {
    let raw = "";
    let overflow = false;
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf-8");
      // The bound is on UTF-8 bytes, not the JS string length.
      if (Buffer.byteLength(raw, "utf-8") > MAX_BODY_BYTES) {
        overflow = true;
        request.destroy();
      }
    });
    request.on("end", () => {
      if (overflow || raw === "") {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    request.on("error", () => resolve(null));
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * Production boot (the container CMD is `node dist/server.js`): read the whole
 * configuration from the environment, fail fast with every missing field listed
 * (`.env.example` contract — the worker refuses to start while the non-model
 * fields are missing), then serve. Model fields are NOT boot requirements: a
 * worker may boot for health and reconciliation, and refusals of unconfigured
 * starts happen per start (503 AI_WORKER_NOT_CONFIGURED). Loaded as a module
 * (tests, tooling) this file never starts a server.
 */
async function run(): Promise<void> {
  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`manao-pi-worker: ${error.message}`);
      process.exitCode = 78; // EX_CONFIG: never serve starts the configuration cannot drive
      return;
    }
    throw error;
  }
  const handle = createTaskServer(config);
  const port = await handle.listen();
  console.log(`manao-pi-worker listening on ${port} (instance ${config.instanceId})`);
  const shutdown = (signal: string): void => {
    console.log(`manao-pi-worker received ${signal}; closing`);
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await run();
}
