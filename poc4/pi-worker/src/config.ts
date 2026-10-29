/**
 * Worker configuration (stage one). Non-model fields are validated at boot so the
 * process fails fast instead of serving starts it can never drive. The model fields
 * are validated per start: a worker without a complete model configuration refuses
 * starts with a fixed, safe error before any session is created — the model key only
 * ever lives in the worker environment and the model runtime, never in the backend,
 * the project, or a development Job.
 *
 * The boot identity is never a fixed instance string: MANAO_AI_INSTANCE_ID only
 * prefixes the identity and a fresh bootId is embedded per process, so a restarted
 * worker can never answer under the dead process's identity (the backend binds the
 * instance once per task and refuses a foreign instance afterwards).
 */
import { randomUUID } from "node:crypto";

export interface PiModelConfig {
  provider: string;
  apiType: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface WorkerPaths {
  /** Session cwd: a worker-private scratch directory, never a user project. */
  scratchDir: string;
  /** Private Pi agent dir holding models.json and auth state for this worker only. */
  agentDir: string;
  /** Private on-disk session transcript directory. */
  sessionDir: string;
}

export interface WorkerBudgets {
  wallClockSeconds: number;
  toolCalls: number;
  builds: number;
}

export interface WorkerConfig {
  port: number;
  /** Token the backend must present on worker routes; empty disables every route. */
  workerToken: string;
  backendBaseUrl: string;
  /** Internal token the worker presents on backend /internal routes. */
  backendToken: string;
  /** The per-boot auth identity presented to the backend (never a fixed string). */
  instanceId: string;
  /** The per-process boot identifier surfaced by GET /status for restart diagnostics. */
  bootId: string;
  model: PiModelConfig | null;
  paths: WorkerPaths;
  budgets: WorkerBudgets;
}

export class ConfigError extends Error { }

function required(env: NodeJS.ProcessEnv, name: string, problems: string[]): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    problems.push(`${name} is required`);
    return "";
  }
  return value.trim();
}

function optional(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return value === undefined ? "" : value.trim();
}

/** Reads the worker configuration from the environment, listing every missing field. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const problems: string[] = [];
  const port = optional(env, "MANAO_AI_WORKER_PORT");
  const portNumber = port === "" ? 18090 : Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
    problems.push("MANAO_AI_WORKER_PORT must be a valid port");
  }
  const workerToken = required(env, "MANAO_AI_WORKER_TOKEN", problems);
  const backendBaseUrl = required(env, "MANAO_AI_BACKEND_BASE_URL", problems);
  const backendToken = required(env, "MANAO_AI_BACKEND_TOKEN", problems);
  const instancePrefix = optional(env, "MANAO_AI_INSTANCE_ID");
  const bootId = randomUUID();
  const scratchDir = optional(env, "MANAO_AI_SCRATCH_DIR");
  const agentDir = optional(env, "MANAO_AI_AGENT_DIR");
  const sessionDir = optional(env, "MANAO_AI_SESSION_DIR");
  if (scratchDir === "") problems.push("MANAO_AI_SCRATCH_DIR is required");
  if (agentDir === "") problems.push("MANAO_AI_AGENT_DIR is required");
  if (sessionDir === "") problems.push("MANAO_AI_SESSION_DIR is required");
  if (problems.length > 0) {
    throw new ConfigError(`worker configuration is incomplete: ${problems.join("; ")}`);
  }
  return {
    port: portNumber,
    workerToken,
    backendBaseUrl: backendBaseUrl.replace(/\/+$/, ""),
    backendToken,
    instanceId: `${instancePrefix === "" ? "pi-worker" : instancePrefix}-${bootId}`,
    bootId,
    model: readModelConfig(env),
    paths: { scratchDir, agentDir, sessionDir },
    budgets: {
      wallClockSeconds: 1800,
      toolCalls: 180,
      builds: 20,
    },
  };
}

/**
 * The model configuration is optional at boot: a worker may boot for health and
 * reconciliation, but a start is refused while any model field is missing.
 */
export function readModelConfig(env: NodeJS.ProcessEnv): PiModelConfig | null {
  const model: PiModelConfig = {
    provider: optional(env, "MANAO_AI_PROVIDER"),
    apiType: optional(env, "MANAO_AI_API_TYPE"),
    baseUrl: optional(env, "MANAO_AI_BASE_URL"),
    model: optional(env, "MANAO_AI_MODEL"),
    apiKey: optional(env, "MANAO_AI_API_KEY"),
  };
  if (Object.values(model).every((value) => value === "")) {
    return null;
  }
  return model;
}

/** Every missing model field; a non-empty list means starts must be refused. */
export function modelConfigProblems(model: PiModelConfig | null): string[] {
  if (model === null) {
    return ["MANAO_AI_PROVIDER", "MANAO_AI_API_TYPE", "MANAO_AI_BASE_URL", "MANAO_AI_MODEL", "MANAO_AI_API_KEY"]
      .map((name) => `${name} is required`);
  }
  const problems: string[] = [];
  const pairs: Array<[string, string]> = [
    ["MANAO_AI_PROVIDER", model.provider],
    ["MANAO_AI_API_TYPE", model.apiType],
    ["MANAO_AI_BASE_URL", model.baseUrl],
    ["MANAO_AI_MODEL", model.model],
    ["MANAO_AI_API_KEY", model.apiKey],
  ];
  for (const [name, value] of pairs) {
    if (value === "") problems.push(`${name} is required`);
  }
  return problems;
}
