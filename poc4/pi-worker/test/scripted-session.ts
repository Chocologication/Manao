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
  convertToLlm,
  SettingsManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { afterEach, vi } from "vitest";
import type { ToolResult } from "../src/backend-client.js";
import type { WorkerBudgets } from "../src/config.js";

// ---------------------------------------------------------------------------
// Scripted model adapter: a faux streamFn the way the SDK's own test harness
// builds one. The SDK runs its own loop; the fake project tool (BackendClient
// stub) only provides the actual returns.
// ---------------------------------------------------------------------------

export interface ScriptedResponse {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  stopReason?: StopReason;
  errorMessage?: string;
  usageTokens?: number;
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
    usage: response.usageTokens === undefined ? USAGE : { ...USAGE, input: response.usageTokens, output: 0, totalTokens: response.usageTokens },
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

export function scriptedSessionFactory(responses: ScriptedResponse[], observe?: (context: TranscriptContext, session: AgentSession) => void,
  respond?: (context: TranscriptContext, session: AgentSession, signal?: AbortSignal) => ScriptedResponse | Promise<ScriptedResponse>) {
  let call = 0;
  return (options: CreateAgentSessionOptions): { session: AgentSession } => {
    let session: AgentSession;
    const agent = new Agent({
      convertToLlm,
      getApiKey: () => "test-only-key",
      initialState: { model: options.model as Model<"openai-completions">, systemPrompt: "", tools: [], messages: options.sessionManager!.buildSessionContext().messages },
      streamFn: (_model, _context, streamOptions) => {
        observe?.(_context, session);
        // A real provider honors the abort signal and ends the stream aborted;
        // the harness models the same contract.
        if (streamOptions?.signal?.aborted) {
          const aborted = scriptedMessage({ stopReason: "aborted" });
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => emitScriptedStream(stream, aborted));
          return stream;
        }
        const response = respond ? respond(_context, session, streamOptions?.signal) : responses[Math.min(call, responses.length - 1)]!;
        call++;
        const stream = createAssistantMessageEventStream();
        void Promise.resolve(response).then((value) => emitScriptedStream(stream, scriptedMessage(value)));
        return stream;
      },
    });
    session = new AgentSession({
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

export interface RecordedCall { taskId: string; request: { toolCallId: string; name: string; expectedRevision: number; args: unknown } }

export function backendStub(results: Array<(call: RecordedCall) => ToolResult>) {
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

export function resultFor(call: RecordedCall): ToolResult {
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

export const MODEL_CONFIG = {
  provider: "manao-test",
  apiType: "openai-completions",
  baseUrl: "http://127.0.0.1:9",
  model: "scripted-1",
  apiKey: "test-only-key",
};

export interface SessionOverrides {
  budgets?: WorkerBudgets;
  settingsManager?: unknown;
  observeOptions?: (options: CreateAgentSessionOptions) => void;
}

const tempDirs: string[] = [];

export function privateDirs(): { scratchDir: string; agentDir: string; sessionDir: string } {
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
