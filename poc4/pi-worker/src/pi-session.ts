/**
 * The minimal Pi assembly (stage one): one agent session per task, driven by the
 * SDK's own loop, with discovery explicitly disabled — no project extensions, no
 * Skills, no prompt templates, no themes, no AGENTS/context files, and no built-in
 * file/bash tools. The session sees exactly the six backend-mediated project tools
 * and one fixed, server-owned system prompt. The model key lives only in the worker
 * environment and the private ModelRuntime; the session cwd is a worker-private
 * scratch directory, never a user project or the Manao repository.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ModelRuntime as ModelRuntimeType,
  type SessionManager as SessionManagerType,
  type SettingsManager as SettingsManagerType,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
// Registers the built-in API transports ("openai-completions", "anthropic-messages",
// ...) into the pi-ai provider registry. Without this side-effect import the
// registry is empty: models.json can declare whatever api id it likes and every
// prompt dies with "No API provider registered for api: ..." — measured live in the
// stage-one acceptance deployment on 2026-10-15, where the task hung silently
// because the resulting terminal could not be reported either.
import "@earendil-works/pi-ai/compat";
import type { BackendClient, ProgressChain } from "./backend-client.js";
import { PROGRESS_TEXT_MAX_BYTES } from "./backend-client.js";
import { modelConfigProblems, type PiModelConfig, type WorkerBudgets, type WorkerPaths } from "./config.js";
import { createProjectTools, TOOL_NAMES } from "./project-tools.js";

/** Stage-one budgets (spec section 3, binding). */
export const DEFAULT_BUDGETS: WorkerBudgets = { wallClockSeconds: 1800, toolCalls: 60, builds: 8 };

/**
 * Progress items are bounded at 8 KiB of UTF-8 text each (spec section 3). The
 * terminal item's own budget is the WHOLE serialized payload and is applied by
 * ProgressChain.sendTerminal (review fix I8); this constant remains the plain
 * text bound for message items.
 */
const MAX_PROGRESS_TEXT_BYTES = PROGRESS_TEXT_MAX_BYTES;

/**
 * The fixed server-side system prompt: goal, tool capabilities, limits and the
 * completion evidence. It deliberately does NOT pre-write code-change or retry
 * steps — the model plans its own rounds from the tool results.
 */
const SYSTEM_PROMPT = [
  "You are the Manao coding agent working on ONE user project through six mediated tools.",
  "",
  "Goal: complete the user's task inside the project and report what you changed.",
  "",
  "Tools: list_files, read_file and write_file reach the project's allowlisted files through the",
  "Manao workspace; build runs one fixed goal (compile, test or package) on an isolated read-only",
  "copy and returns the real exit result with bounded diagnostics. application starts, stops, observes",
  "and reads persisted logs for this project's application; app_http_get performs a bounded GET",
  "on the current ready application and returns the real status and body. You have no other tools, no",
  "shell, and no direct filesystem access.",
  "",
  "Limits: files are capped at 128 KiB; the tool answers are bounded; a non-zero build exit code",
  "or a data.error answer is an ordinary result you should read and act on in your next round.",
  "A start accepted result does not prove the application is ready. Stop must be confirmed before",
  "editing or building. Source writes and builds are refused while any application Run is active.",
  "Use status to confirm readiness and stoppedConfirmed to confirm exit; unknown or timeout is not exit proof.",
  "A ready application may stay available after completion. Use real build, Run, logs and HTTP results",
  "as completion evidence, and distinguish accepted startup, readiness and successful HTTP checks.",
  "You cannot see or touch anything outside the mediated tool answers.",
  "",
  "Completion evidence: finish with a short summary of what you changed (paths) and the build",
  "outcome that proves it works. If you cannot complete the task, stop and say exactly why.",
].join("\n");

export interface PiSessionDeps {
  /** Overrides createAgentSession (tests script the model through the same AgentSession). */
  createSession?: (options: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
  modelRuntime?: ModelRuntimeType;
  settingsManager?: SettingsManagerType;
  sessionManager?: SessionManagerType;
  now?: () => number;
}

export interface PiTaskStart {
  prompt: string;
  workspaceRevision: string;
}

export interface PiTaskOutcome {
  state: "COMPLETED" | "FAILED";
  summary: string;
  failureCode: string | null;
  reason: string;
}

export interface PiTaskSession {
  readonly taskId: string;
  readonly registeredTools: ToolDefinition[];
  run(start: PiTaskStart): Promise<PiTaskOutcome>;
  stop(): void;
  dispose(): void;
}

export class WorkerNotConfiguredError extends Error { }

/**
 * Creates the session for one task. The model runtime is built (or reused from the
 * injected dependency), the model is resolved from the private models.json, the
 * controlled resource loader fixes the system prompt, and the six custom tools are
 * registered through an explicit allowlist with noTools "builtin". Sequential tool
 * execution is enforced twice: on the agent loop and per tool definition.
 */
export async function createPiSession(options: {
  model: PiModelConfig;
  paths: WorkerPaths;
  budgets?: WorkerBudgets;
  backend: BackendClient;
  progress: ProgressChain;
  taskId: string;
  /** The workspace revision carried by WorkerStart; seeds the tracked revision. */
  startRevision?: string;
  deps?: PiSessionDeps;
}): Promise<PiTaskSession> {
  const { model, paths, backend, progress, taskId, deps } = options;
  const budgets = options.budgets ?? DEFAULT_BUDGETS;
  const problems = modelConfigProblems(model);
  if (problems.length > 0) {
    throw new WorkerNotConfiguredError(`model configuration is incomplete: ${problems.join("; ")}`);
  }

  const settingsManager = deps?.settingsManager ?? SettingsManager.inMemory();
  const sessionManager = deps?.sessionManager ?? SessionManager.create(paths.scratchDir, paths.sessionDir);
  const modelRuntime = deps?.modelRuntime ?? await buildModelRuntime(model, paths.agentDir);
  const resolved = modelRuntime.getModel(model.provider, model.model);
  if (!resolved) {
    throw new WorkerNotConfiguredError(`model ${model.provider}/${model.model} is not resolvable from the private models.json`);
  }

  const loader = new DefaultResourceLoader({
    cwd: paths.scratchDir,
    agentDir: paths.agentDir,
    settingsManager,
    // Explicit, fixed discovery suppression: nothing may be loaded from the disk
    // beyond this controlled configuration.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: SYSTEM_PROMPT,
  });
  await loader.reload();

  // The expected revision is worker-tracked state: seeded from WorkerStart and
  // advanced by every observed tool result, never taken from model arguments.
  let observedRevision = Number.parseInt(options.startRevision ?? "0", 10) || 0;
  let fatalToolCode: string | null = null;
  let abortAfterFatal = () => { };
  const customTools = createProjectTools({
    backend,
    taskId,
    getRevision: () => String(observedRevision),
    onResult: (result) => {
      const seen = Number.parseInt(result.workspaceRevision, 10);
      if (Number.isFinite(seen) && seen > observedRevision) observedRevision = seen;
    },
    onFatal: (code) => {
      fatalToolCode ??= code;
      abortAfterFatal();
    },
  });

  const createSession = deps?.createSession ?? createAgentSession;
  const { session } = await createSession({
    cwd: paths.scratchDir,
    agentDir: paths.agentDir,
    modelRuntime,
    model: resolved,
    settingsManager,
    sessionManager,
    resourceLoader: loader,
    noTools: "builtin",
    tools: [...TOOL_NAMES],
    customTools,
  });
  session.agent.toolExecution = "sequential";
  abortAfterFatal = () => session.agent.abort();

  return new DefaultPiTaskSession(taskId, session, customTools, progress, budgets, () => deps?.now?.() ?? Date.now(), () => fatalToolCode);
}

/**
 * Builds the private model runtime: a models.json inside the private agent dir
 * declares exactly the configured provider/model, and the API key is registered at
 * runtime only — nothing is written to the project, the Job, or any shared volume.
 */
/**
 * Maps the deployment's friendly API-type value onto the pi-ai transport id. The
 * secret carries "openai" (OpenAI-compatible /chat/completions — the DeepSeek
 * shape), but the registry's builtin id for that transport is "openai-completions";
 * any other value is the operator naming the transport directly and passes through.
 */
function sdkApiId(apiType: string): string {
  return apiType === "openai" ? "openai-completions" : apiType;
}

async function buildModelRuntime(model: PiModelConfig, agentDir: string): Promise<ModelRuntimeType> {
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({
    providers: {
      [model.provider]: {
        name: model.provider,
        baseUrl: model.baseUrl,
        api: sdkApiId(model.apiType),
        models: [{
          id: model.model,
          name: model.model,
          reasoning: true,
          contextWindow: 200000,
          maxTokens: 8192,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2), "utf-8");
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath,
  });
  await runtime.setRuntimeApiKey(model.provider, model.apiKey);
  return runtime;
}

class DefaultPiTaskSession implements PiTaskSession {
  private readonly unsubscribe: () => void;
  private aborted = false;
  private running = false;
  private settled = false;
  private toolCalls = 0;
  private builds = 0;
  private deadlineAt = 0;

  constructor(
    readonly taskId: string,
    private readonly session: AgentSession,
    readonly registeredTools: ToolDefinition[],
    private readonly progress: ProgressChain,
    private readonly budgets: WorkerBudgets,
    private readonly now: () => number,
    private readonly fatalToolCode: () => string | null,
  ) {
    this.unsubscribe = session.subscribe((event) => this.onEvent(event));
  }

  stop(): void {
    this.aborted = true;
    this.session.agent.abort();
  }

  dispose(): void {
    this.unsubscribe();
  }

  async run(start: PiTaskStart): Promise<PiTaskOutcome> {
    if (this.running) {
      throw new Error("the task session is already running");
    }
    this.running = true;
    this.deadlineAt = this.now() + this.budgets.wallClockSeconds * 1000;
    const deadline = setTimeout(() => {
      // Budget wall clock: stop the loop; the settlement reports the breach.
      this.aborted = true;
      this.session.agent.abort();
    }, this.budgets.wallClockSeconds * 1000);
    let promptError: unknown = null;
    try {
      await this.session.prompt(start.prompt);
    } catch (error) {
      promptError = error;
    } finally {
      clearTimeout(deadline);
    }
    const outcome = this.settle(promptError);
    this.running = false;
    // The terminal state is only sent after the progress chain has drained, so the
    // complete-message and tool items always precede it.
    await this.progress.sendTerminal(outcome.state, outcome.summary, outcome.failureCode);
    return outcome;
  }

  private onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_end": {
        // Complete messages only — message_update deltas are never persisted.
        const message = event.message;
        if (message?.role === "assistant") {
          const text = (message as AssistantMessage).content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("")
            .trim();
          const bounded = truncate(text, MAX_PROGRESS_TEXT_BYTES);
          this.progress.send("message", bounded.text, bounded.truncated);
        }
        return;
      }
      case "tool_execution_start": {
        this.toolCalls++;
        if (event.toolName === "build") {
          this.builds++;
        }
        if (this.overBudget()) {
          this.aborted = true;
          this.session.agent.abort();
        }
        this.progress.send("tool_start", `${event.toolName} ${event.toolCallId}`);
        return;
      }
      case "tool_execution_end": {
        this.progress.send("tool_end", `${event.toolName} ${event.toolCallId}`);
        return;
      }
      default:
        return;
    }
  }

  private overBudget(): boolean {
    return this.toolCalls > this.budgets.toolCalls
      || this.builds > this.budgets.builds
      || this.now() > this.deadlineAt;
  }

  private settle(promptError: unknown): PiTaskOutcome {
    if (this.settled) {
      throw new Error("the task session already settled");
    }
    this.settled = true;
    const messages = this.session.agent.state.messages;
    const lastAssistant = [...messages].reverse()
      .find((message) => message.role === "assistant") as AssistantMessage | undefined;
    const summary = lastAssistant === undefined ? "" : messageText(lastAssistant);
    const bounded = truncate(summary, MAX_PROGRESS_TEXT_BYTES);

    const fatalCode = this.fatalToolCode();
    if (fatalCode !== null) {
      return { state: "FAILED", summary: bounded.text, failureCode: fatalCode,
        reason: "the task stopped after an unresolved tool outcome" };
    }

    if (promptError !== null) {
      return {
        state: "FAILED",
        summary: bounded.text,
        failureCode: "AI_PROVIDER_ERROR",
        reason: promptError instanceof Error ? promptError.message : "the prompt run failed",
      };
    }
    if (this.overBudget()) {
      return {
        state: "FAILED",
        summary: bounded.text,
        failureCode: "AI_BUDGET_EXCEEDED",
        reason: `budget exceeded (toolCalls=${this.toolCalls}/${this.budgets.toolCalls}, builds=${this.builds}/${this.budgets.builds})`,
      };
    }
    if (this.aborted || lastAssistant?.stopReason === "aborted") {
      return {
        state: "FAILED",
        summary: bounded.text,
        failureCode: "AI_ABORTED",
        reason: "the task was aborted before it completed",
      };
    }
    if (lastAssistant?.stopReason === "error") {
      // A provider error settles normally through the SDK loop; it is never a success.
      return {
        state: "FAILED",
        summary: bounded.text,
        failureCode: "AI_PROVIDER_ERROR",
        reason: lastAssistant.errorMessage ?? "the model provider returned an error",
      };
    }
    if (lastAssistant?.stopReason === "length") {
      return {
        state: "FAILED",
        summary: bounded.text,
        failureCode: "AI_LENGTH_LIMIT",
        reason: "the model hit its length limit before finishing",
      };
    }
    return {
      state: "COMPLETED",
      summary: bounded.text,
      failureCode: null,
      reason: "the model finished with a final answer",
    };
  }
}

function messageText(message: AssistantMessage): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= maxBytes) {
    return { text, truncated: false };
  }
  let cut = text.length;
  while (cut > 0 && Buffer.byteLength(text.slice(0, cut), "utf-8") > maxBytes) {
    cut = Math.floor(cut * 0.9);
  }
  return { text: text.slice(0, cut), truncated: true };
}
