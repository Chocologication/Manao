import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StopReason,
  type TextContent,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  AgentSession,
  SettingsManager,
  type CreateAgentSessionOptions,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendClient, ProgressChain, type ToolResult } from "../src/backend-client.js";
import { createPiSession, type PiTaskOutcome } from "../src/pi-session.js";

// ---------------------------------------------------------------------------
// Scripted model adapter: a faux streamFn the way the SDK's own test harness
// builds one. The SDK runs its own loop; the fake project tool (BackendClient
// stub) only provides the actual returns.
// ---------------------------------------------------------------------------

interface ScriptedResponse {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  stopReason?: StopReason;
  errorMessage?: string;
}

const USAGE: Usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function scriptedMessage(response: ScriptedResponse): AssistantMessage {
  const content: Array<TextContent | ToolCall> = [];
  if (response.text !== undefined) content.push({ type: "text", text: response.text });
  for (const call of response.toolCalls ?? []) {
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.args });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  let stopReason: StopReason = response.stopReason ?? (response.toolCalls?.length ? "toolUse" : "stop");
  if (response.errorMessage) stopReason = "error";
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "manao-test",
    model: "scripted-1",
    usage: USAGE,
    stopReason,
    ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function emitScriptedStream(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
  stream.push({ type: "start", partial: { ...partial } });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      partial.content = [...partial.content, { type: "text", text: "" }];
      stream.push({ type: "text_start", contentIndex: index, partial: { ...partial } });
      stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: { ...partial } });
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: { ...partial } });
    } else {
      partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
      stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
      stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(block.arguments), partial: { ...partial } });
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: { ...partial } });
    }
  });
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
    return;
  }
  stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse" | "length", message });
}

function scriptedSessionFactory(responses: ScriptedResponse[]) {
  let call = 0;
  return (options: CreateAgentSessionOptions): { session: AgentSession } => {
    const agent = new Agent({
      getApiKey: () => "test-only-key",
      initialState: { model: options.model as Model<"openai-completions">, systemPrompt: "", tools: [] },
      streamFn: (_model, _context, streamOptions) => {
        // A real provider honors the abort signal and ends the stream aborted;
        // the harness models the same contract.
        if (streamOptions?.signal?.aborted) {
          const aborted = scriptedMessage({ stopReason: "aborted" });
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => emitScriptedStream(stream, aborted));
          return stream;
        }
        const response = responses[Math.min(call, responses.length - 1)]!;
        call++;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => emitScriptedStream(stream, scriptedMessage(response)));
        return stream;
      },
    });
    const session = new AgentSession({
      agent,
      sessionManager: options.sessionManager!,
      settingsManager: options.settingsManager!,
      cwd: options.cwd!,
      resourceLoader: options.resourceLoader!,
      customTools: options.customTools,
      modelRuntime: options.modelRuntime!,
      initialActiveToolNames: options.tools,
      allowedToolNames: options.tools,
      usesDefaultTools: false,
    });
    return { session };
  };
}

// ---------------------------------------------------------------------------
// Fake backend + test scaffolding
// ---------------------------------------------------------------------------

interface RecordedCall { taskId: string; request: { toolCallId: string; name: string; expectedRevision: number; args: unknown } }

function backendStub(results: Array<(call: RecordedCall) => ToolResult>) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const invoke = vi.fn(async (taskId: string, request: RecordedCall["request"]): Promise<ToolResult> => {
    calls.push({ taskId, request });
    const produce = results[Math.min(index, results.length - 1)]!;
    index++;
    return produce({ taskId, request });
  });
  const progressItems: Array<{ seq: number; kind: string; text: string; truncated: boolean }> = [];
  const progress = vi.fn(async (taskId: string, item: { seq: number; kind: string; text: string; truncated: boolean }) => {
    progressItems.push(item);
    return { accepted: true };
  });
  return { invoke, calls, progress, progressItems };
}

function resultFor(call: RecordedCall): ToolResult {
  const name = call.request.name;
  if (name === "list_files") {
    return { toolCallId: call.request.toolCallId, workspaceRevision: "7", data: { directory: "", entries: [], hasMore: false }, truncated: false };
  }
  if (name === "read_file") {
    return { toolCallId: call.request.toolCallId, workspaceRevision: "7", data: { path: "src/Demo.java", content: "class Demo {}", sha256: "a".repeat(64) }, truncated: false };
  }
  if (name === "write_file") {
    return { toolCallId: call.request.toolCallId, workspaceRevision: "8", data: { path: "src/Demo.java", sha256: "b".repeat(64) }, truncated: false };
  }
  // build
  return { toolCallId: call.request.toolCallId, workspaceRevision: "8", data: { goal: "compile", exitCode: 0, terminationReason: "completed", output: "BUILD SUCCESS", cleanupConfirmed: true, testReports: [] }, truncated: false };
}

const MODEL_CONFIG = {
  provider: "manao-test",
  apiType: "openai-completions",
  baseUrl: "http://127.0.0.1:9",
  model: "scripted-1",
  apiKey: "test-only-key",
};

const BUDGETS = { wallClockSeconds: 1800, toolCalls: 60, builds: 8 };

interface SessionOverrides {
  budgets?: typeof BUDGETS;
  settingsManager?: unknown;
}

const tempDirs: string[] = [];

function privateDirs(): { scratchDir: string; agentDir: string; sessionDir: string } {
  const scratchDir = mkdtempSync(join(tmpdir(), "manao-pi-scratch-"));
  const agentDir = join(scratchDir, "agent");
  const sessionDir = join(scratchDir, "sessions");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "manao-test": {
        name: "Manao Scripted Test",
        baseUrl: MODEL_CONFIG.baseUrl,
        api: MODEL_CONFIG.apiType,
        models: [{
          id: MODEL_CONFIG.model,
          name: "Scripted Model",
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 8192,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2), "utf-8");
  tempDirs.push(scratchDir);
  return { scratchDir, agentDir, sessionDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function runScriptedTask(
  responses: ScriptedResponse[],
  results: Array<(call: RecordedCall) => ToolResult> = [resultFor],
  overrides: SessionOverrides = {},
): Promise<{ outcome: PiTaskOutcome; backend: ReturnType<typeof backendStub>; tools: ToolDefinition[] }> {
  const backend = backendStub(results);
  const chain = new ProgressChain(backend as unknown as BackendClient, "task-1");
  const pi = await createPiSession({
    model: MODEL_CONFIG,
    paths: privateDirs(),
    budgets: overrides.budgets ?? BUDGETS,
    backend: backend as never,
    progress: chain,
    taskId: "task-1",
    deps: {
      createSession: scriptedSessionFactory(responses) as never,
      ...(overrides.settingsManager !== undefined
        ? { settingsManager: overrides.settingsManager as never }
        : {}),
    },
  });
  const outcome = await pi.run({ prompt: "Fix the failing build and report what changed.", workspaceRevision: "7" });
  const tools = pi.registeredTools;
  return { outcome, backend, tools };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi session", () => {
  it("drives read -> write -> failing build -> fix -> passing build to completion", async () => {
    const { outcome, backend } = await runScriptedTask([
      { text: "Reading the source.", toolCalls: [{ id: "c1", name: "read_file", args: { path: "src/Demo.java" } }] },
      { toolCalls: [{ id: "c2", name: "write_file", args: { path: "src/Demo.java", content: "class Demo {} // fixed" } }] },
      { toolCalls: [{ id: "c3", name: "build", args: { goal: "compile" } }] },
      { text: "The build still fails; applying the missing import.", toolCalls: [{ id: "c4", name: "write_file", args: { path: "src/Demo.java", content: "class Demo {} // fixed for real" } }] },
      { toolCalls: [{ id: "c5", name: "build", args: { goal: "compile" } }] },
      { text: "Build passes now. Changed src/Demo.java.", },
    ], [
      resultFor,
      () => ({ toolCallId: "c2", workspaceRevision: "8", data: { path: "src/Demo.java", sha256: "b".repeat(64) }, truncated: false }),
      () => ({ toolCallId: "c3", workspaceRevision: "8", data: { goal: "compile", exitCode: 1, terminationReason: "completed", output: "BUILD FAILURE: cannot find symbol", cleanupConfirmed: true, testReports: [] }, truncated: false }),
      () => ({ toolCallId: "c4", workspaceRevision: "9", data: { path: "src/Demo.java", sha256: "c".repeat(64) }, truncated: false }),
      () => ({ toolCallId: "c5", workspaceRevision: "9", data: { goal: "compile", exitCode: 0, terminationReason: "completed", output: "BUILD SUCCESS", cleanupConfirmed: true, testReports: [] }, truncated: false }),
    ]);
    // The SDK loop ran every round itself; the non-zero build diagnostics reached the model,
    // which answered with the repair write and the next build round.
    expect(backend.calls.map((call) => call.request.name)).toEqual([
      "read_file", "write_file", "build", "write_file", "build",
    ]);
    expect(outcome.state).toBe("COMPLETED");
    expect(outcome.summary).toContain("Changed src/Demo.java");
    // Terminal state is reported exactly once through the progress chain.
    const terminals = backend.progressItems.filter((item) => item.kind === "terminal");
    expect(terminals).toHaveLength(1);
    expect(JSON.parse(terminals[0]!.text)).toMatchObject({ state: "COMPLETED" });
  });

  it("registers exactly the four project tools and nothing else", async () => {
    const { tools } = await runScriptedTask([{ text: "done" }]);
    expect(tools.map((tool) => tool.name)).toEqual(["list_files", "read_file", "write_file", "build"]);
  });

  it("persists complete messages only, never per-token deltas", async () => {
    const { backend } = await runScriptedTask([
      { text: "A full assistant message after the deltas." },
    ]);
    const messageItems = backend.progressItems.filter((item) => item.kind === "message");
    expect(messageItems).toHaveLength(1);
    expect(messageItems[0]!.text).toBe("A full assistant message after the deltas.");
    // The faux stream emitted text_delta events; none of them became a progress item.
    expect(backend.progressItems.every((item) => item.kind === "message" || item.kind === "terminal")).toBe(true);
  });

  it("does not settle while the SDK schedules a retry, then completes on the retried turn", async () => {
    const { outcome, backend } = await runScriptedTask([
      { errorMessage: "provider overloaded (503)", stopReason: "error" },
      { text: "Recovered and done." },
    ], [resultFor], {
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxAgentDelayMs: 1000 },
      }),
    });
    expect(outcome.state).toBe("COMPLETED");
    // No terminal state was reported for the retrying first attempt.
    const terminals = backend.progressItems.filter((item) => item.kind === "terminal");
    expect(terminals).toHaveLength(1);
    expect(JSON.parse(terminals[0]!.text)).toMatchObject({ state: "COMPLETED" });
  });

  it("reports FAILED when a provider error settles normally", async () => {
    const { outcome, backend } = await runScriptedTask([
      { errorMessage: "authentication failed: invalid api key", stopReason: "error" },
    ], [resultFor], {
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 1, maxAgentDelayMs: 1000 },
      }),
    });
    expect(outcome.state).toBe("FAILED");
    expect(outcome.failureCode).toBe("AI_PROVIDER_ERROR");
    const terminals = backend.progressItems.filter((item) => item.kind === "terminal");
    expect(JSON.parse(terminals[0]!.text)).toMatchObject({ state: "FAILED", failureCode: "AI_PROVIDER_ERROR" });
  });

  it("stops honestly at the tool-call budget", async () => {
    const { outcome } = await runScriptedTask(
      [{ toolCalls: [{ id: "c1", name: "list_files", args: { directory: "" } }] }],
      [resultFor],
      { budgets: { wallClockSeconds: 1800, toolCalls: 2, builds: 8 } },
    );
    expect(outcome.state).toBe("FAILED");
    expect(outcome.failureCode).toBe("AI_BUDGET_EXCEEDED");
  });
});
