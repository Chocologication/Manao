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
import { BackendClient, ProgressChain } from "./backend-client.js";
import { ConfigError, loadWorkerConfig, modelConfigProblems, type WorkerConfig } from "./config.js";
import { createPiSession, type PiTaskOutcome, type PiTaskSession } from "./pi-session.js";

export interface WorkerStartBody {
  taskId: string;
  prompt: string;
  workspaceRevision: string;
  requestSha256: string;
  workerEpoch: number;
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
  let active: TaskRecord | null = null;
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
    const record = createRecord(start);
    tasks.set(taskId, record);
    active = record;
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
      .catch(() => {
        record.outcome = { state: "FAILED", summary: "", failureCode: "AI_WORKER_ERROR", reason: "the task runner failed before it could settle" };
        // Even a failure before any session existed must reach the backend as a
        // terminal state through the same serialized progress chain.
        void record.progress.sendTerminal("FAILED", "", "AI_WORKER_ERROR");
      })
      .finally(() => {
        if (active === record) {
          active = null;
        }
      });
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
        });
        const outcome = await session.run({
          prompt: runnerDeps.start.prompt,
          workspaceRevision: runnerDeps.start.workspaceRevision,
        });
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
    if (typeof candidate["requestSha256"] !== "string" || !SHA256.test(candidate["requestSha256"])) {
      return "requestSha256 must be a sha-256 hex digest";
    }
    if (typeof candidate["workerEpoch"] !== "number" || !Number.isInteger(candidate["workerEpoch"]) || candidate["workerEpoch"] < 0) {
      return "workerEpoch must be a non-negative integer";
    }
    return {
      taskId,
      prompt: candidate["prompt"],
      workspaceRevision: candidate["workspaceRevision"],
      requestSha256: candidate["requestSha256"],
      workerEpoch: candidate["workerEpoch"],
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
    activeTaskId: () => active === null ? null : active.start.taskId,
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
