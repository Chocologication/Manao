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
  estimateTokens,
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
import { COMPACTION_SETTINGS, CONTEXT_WINDOW, ConversationContext, needsCompaction, type CompactStart, type CompactResult } from "./conversation-context.js";
import { LiveOutput } from "./live-output.js";

/** Server-owned task budgets; tool/build limits raised by user instruction on 2026-10-18. */
export const DEFAULT_BUDGETS: WorkerBudgets = { wallClockSeconds: 1800, toolCalls: 180, builds: 20 };

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
  conversationId?: string | null;
  reasoningEffort?: "off" | "low" | "high" | "max";
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

  const settingsManager = deps?.settingsManager ?? SettingsManager.inMemory({ compaction: COMPACTION_SETTINGS });
  const context = options.conversationId ? await ConversationContext.load(backend, taskId, options.conversationId) : undefined;
  const sessionManager = context
    ? SessionManager.inMemory(paths.scratchDir, { id: options.conversationId! }, structuredClone(context.fileEntries))
    : deps?.sessionManager ?? SessionManager.create(paths.scratchDir, paths.sessionDir);
  context?.prepare(sessionManager, options.startRevision ?? "0");
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
  let flush = async () => {};
  const customTools = createProjectTools({
    backend,
    taskId,
    getRevision: () => String(observedRevision),
    ...(context ? { beforeInvoke: () => flush() } : {}),
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
  session.setThinkingLevel(options.reasoningEffort ?? "high", { persist: false });
  session.agent.toolExecution = "sequential";
  abortAfterFatal = () => { session.abortCompaction(); session.agent.abort(); void session.abort().catch(() => {}); };
  let compactionFailed = false;
  let compactionAborted = false;
  session.subscribe((event) => {
    if (event.type === "compaction_start") compactionAborted = false;
    if (event.type === "compaction_end") {
      compactionFailed = !event.result && !event.aborted;
      compactionAborted = event.aborted;
    }
  });
  const refuseOversizedContext = () => {
    if (!needsCompaction(session)) return;
    fatalToolCode ??= "AI_CONTEXT_COMPACTION_FAILED";
    abortAfterFatal();
    throw new Error("active context could not be compacted below the fixed threshold");
  };
  const beforePrompt = async (prompt: string) => {
    // _prepareRun checks the old assistant usage before it inserts the new prompt.
    // Account for the pending trigger and initial system/tool declaration while idle.
    let pending = estimateTokens({ role: "user", content: prompt, timestamp: Date.now() });
    if (!session.sessionManager.buildSessionContext().messages.some((message) => message.role === "system")) {
      pending += estimateTokens({ role: "system", content: session.systemPrompt, timestamp: Date.now(),
        toolsAdded: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });
    }
    if (!needsCompaction(session, pending)) return;
    try { await session.compact(); }
    catch (error) {
      if (!compactionAborted) fatalToolCode ??= "AI_CONTEXT_COMPACTION_FAILED";
      throw error;
    }
    if (needsCompaction(session, pending)) {
      fatalToolCode ??= "AI_CONTEXT_COMPACTION_FAILED";
      throw new Error("compacted context still exceeds the fixed threshold");
    }
  };
  let saveFinal: (() => Promise<void>) | undefined;
  const live = context ? new LiveOutput(backend, taskId, options.conversationId!, context.acknowledgedHeadSeq) : undefined;
  const unsubscribeLive = live ? session.subscribe((event) => live.observe(event)) : undefined;
  if (context) {
    saveFinal = async () => {
      try { await context.flush(session, (entries, headSeq) => live!.checkpoint(entries, headSeq)); }
      catch (error) { fatalToolCode ??= "AI_CONTEXT_UNAVAILABLE"; session.agent.abort(); throw error; }
    };
    flush = async () => {
      if (fatalToolCode !== null) throw new Error("the task has already stopped");
      await saveFinal!();
    };
    // Native summary providers bypass prepareRequest; every provider still awaits ACK.
    const previousStream = session.agent.streamFunction;
    session.agent.streamFunction = async (model, transcript, streamOptions) => {
      streamOptions?.signal?.throwIfAborted();
      await flush();
      streamOptions?.signal?.throwIfAborted();
      return previousStream(model, transcript, streamOptions);
    };
  }
  const previousPrepare = session.agent.prepareRequest;
  session.agent.prepareRequest = async (request, signal) => {
    signal?.throwIfAborted();
    const prepared = await previousPrepare?.(request, signal);
    signal?.throwIfAborted();
    refuseOversizedContext();
    await flush();
    return prepared || undefined;
  };

  return new DefaultPiTaskSession(taskId, session, customTools, progress, budgets, () => deps?.now?.() ?? Date.now(), () => fatalToolCode,
    context ? flush : undefined, saveFinal, beforePrompt, () => { if (compactionFailed) refuseOversizedContext(); }, live, unsubscribeLive);
}

/** Idle-only native summary. This session has no prompt and no project tool authority. */
export async function compactIdleConversation(options: {
  model: PiModelConfig; paths: WorkerPaths; backend: BackendClient; start: CompactStart;
  createSession?: PiSessionDeps["createSession"];
}): Promise<CompactResult> {
  const context = await ConversationContext.loadForCompaction(options.backend, options.start);
  const manager = SessionManager.inMemory(options.paths.scratchDir, { id: options.start.conversationId }, structuredClone(context.fileEntries));
  const settings = SettingsManager.inMemory({ compaction: COMPACTION_SETTINGS });
  const runtime = await buildModelRuntime(options.model, options.paths.agentDir);
  const model = runtime.getModel(options.model.provider, options.model.model);
  if (!model) throw new WorkerNotConfiguredError("The summary model is unavailable");
  const loader = new DefaultResourceLoader({ cwd: options.paths.scratchDir, agentDir: options.paths.agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "" });
  await loader.reload();
  const { session } = await (options.createSession ?? createAgentSession)({ cwd: options.paths.scratchDir, agentDir: options.paths.agentDir,
    modelRuntime: runtime, model, settingsManager: settings, sessionManager: manager, resourceLoader: loader,
    noTools: "builtin", tools: [], customTools: [] });
  let expired = false;
  let providerRequested = false;
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, transcript, streamOptions) => {
    providerRequested = true;
    return stream(model, transcript, streamOptions);
  };
  const timer = setTimeout(() => { expired = true; session.abortCompaction(); }, 120_000);
  try {
    try { await session.compact(); }
    catch (error) {
      if (!expired && !providerRequested && error instanceof Error && ["Already compacted", "Nothing to compact (session too small)"].includes(error.message))
        return { expectedHeadSeq: options.start.expectedHeadSeq, entries: [], usage: null, failureCode: null };
      throw error;
    }
    if (expired) throw new Error("Manual compaction exceeded its deadline");
    return context.compactionResult(session);
  } finally { clearTimeout(timer); session.dispose(); }
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
          thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
          contextWindow: CONTEXT_WINDOW,
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
  private deadlineExpired = false;
  private lastAssistant: AssistantMessage | undefined;

  constructor(
    readonly taskId: string,
    private readonly session: AgentSession,
    readonly registeredTools: ToolDefinition[],
    private readonly progress: ProgressChain,
    private readonly budgets: WorkerBudgets,
    private readonly now: () => number,
    private readonly fatalToolCode: () => string | null,
    private readonly flush?: () => Promise<void>,
    private readonly saveFinal?: () => Promise<void>,
    private readonly beforePrompt?: (prompt: string) => Promise<void>,
    private readonly afterPrompt?: () => void,
    private readonly live?: LiveOutput,
    private readonly unsubscribeLive?: () => void,
  ) {
    this.unsubscribe = session.subscribe((event) => this.onEvent(event));
  }

  stop(): void {
    this.aborted = true;
    this.session.abortCompaction();
    this.session.agent.abort();
    void this.session.abort().catch(() => {});
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeLive?.();
    this.live?.dispose();
  }

  async run(start: PiTaskStart): Promise<PiTaskOutcome> {
    if (this.running) {
      throw new Error("the task session is already running");
    }
    this.running = true;
    this.deadlineAt = this.now() + this.budgets.wallClockSeconds * 1000;
    const deadline = setTimeout(() => {
      // Budget wall clock: stop the loop; the settlement reports the breach.
      this.deadlineExpired = true;
      this.stop();
    }, this.budgets.wallClockSeconds * 1000);
    let promptError: unknown = null;
    try {
      await this.flush?.();
      const prompt = this.flush ? "Execute the user's most recent programming goal recorded above. Use the current workspace revision; re-read relevant files before changes." : start.prompt;
      if (!this.aborted) await this.beforePrompt?.(prompt);
      if (!this.aborted) await this.session.prompt(prompt);
      this.afterPrompt?.();
    } catch (error) {
      promptError = error;
    } finally {
      clearTimeout(deadline);
    }
    try { await this.saveFinal?.(); } catch (error) { promptError ??= error; }
    // The final Context was persisted (or its failure recorded) BEFORE the outcome is
    // frozen; only now does the execution loop exit with its terminal result.
    const outcome = this.settle(promptError);
    this.running = false;
    this.live?.finish();
    // The terminal report is NOT sent here (repair task 4): the frozen outcome is
    // returned to the server, which persists it and hands it to the independent
    // terminal delivery. A delivery failure can therefore never enter this method's
    // error paths nor create a second execution outcome, and the terminal does not
    // depend on the display progress seq at all.
    this.unsubscribe();
    this.unsubscribeLive?.();
    return outcome;
  }

  private onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_end": {
        // Complete messages only — message_update deltas are never persisted.
        const message = event.message;
        if (message?.role === "assistant") {
          this.lastAssistant = message as AssistantMessage;
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
    return this.deadlineExpired || this.toolCalls > this.budgets.toolCalls
      || this.builds > this.budgets.builds
      || this.now() > this.deadlineAt;
  }

  private settle(promptError: unknown): PiTaskOutcome {
    if (this.settled) {
      throw new Error("the task session already settled");
    }
    this.settled = true;
    const lastAssistant = this.lastAssistant;
    const summary = lastAssistant === undefined ? "" : messageText(lastAssistant);
    const bounded = truncate(summary, MAX_PROGRESS_TEXT_BYTES);

    const fatalCode = this.fatalToolCode();
    if (fatalCode !== null) {
      return { state: "FAILED", summary: bounded.text, failureCode: fatalCode,
        reason: "the task stopped after an unresolved tool outcome" };
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
    if (promptError !== null) {
      return {
        state: "FAILED",
        summary: bounded.text,
        failureCode: "AI_PROVIDER_ERROR",
        reason: promptError instanceof Error ? promptError.message : "the prompt run failed",
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
