/**
 * The worker-side projection of the backend's six project tools. Each execute()
 * only forwards to the backend's durable tool-call ledger. The worker never touches
 * the local filesystem, a shell, or any user code: this module imports nothing that
 * could, and every execution goes through {@link BackendClient.invoke}. The expected
 * revision is injected from worker-tracked state (WorkerStart plus every observed
 * tool result), never taken from model-supplied arguments.
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BackendHttpError, type BackendClient, type ToolResult } from "./backend-client.js";

export const TOOL_NAMES = ["list_files", "read_file", "write_file", "build", "application", "app_http_get"] as const;

export interface ProjectToolDeps {
  backend: BackendClient;
  taskId: string;
  /** The worker-tracked workspace revision injected into every tool request. */
  getRevision: () => string;
  /** Observes each settled tool result (revision tracking, diagnostics). */
  onResult?: (result: ToolResult) => void;
  /** Stops the session after a tool outcome can no longer be safely established. */
  onFatal?: (code: string) => void;
  beforeInvoke?: () => Promise<void>;
}

const directoryArgs = Type.Object({
  directory: Type.Optional(Type.String({ description: "Project-relative directory to list; empty for the root." })),
});

const pathArgs = Type.Object({
  path: Type.String({ description: "Project-relative file path." }),
});

const writeArgs = Type.Object({
  path: Type.String({ description: "Project-relative file path to write." }),
  content: Type.String({ description: "Full new text content of the file (UTF-8, max 128 KiB)." }),
  expectedSha256: Type.Optional(Type.String({ description: "SHA-256 of the version being replaced; omit to create a new file." })),
});

const buildArgs = Type.Object({
  goal: Type.Union([
    Type.Literal("compile"),
    Type.Literal("test"),
    Type.Literal("package"),
  ], { description: "The fixed build goal; there is no arbitrary command execution." }),
});

// Model providers require a top-level object. The backend remains authoritative
// for each action's required/allowed fields; the model sees those rules below.
const applicationArgs = Type.Object({
  action: Type.String({ enum: ["start", "status", "stop", "logs"] }),
  runId: Type.Optional(Type.String({ description: "Required for stop and logs; optional for status; omit for start. Use the exact Run ID from an earlier result." })),
  waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Only for status and stop. Integer seconds to wait, 0–10; omit for start and logs." })),
}, { additionalProperties: false });

const appHttpGetArgs = Type.Object({ runId: Type.String(), path: Type.String({ maxLength: 2048 }) }, { additionalProperties: false });

/**
 * Creates the six sequential tool definitions. The SDK runs the loop; these tools
 * only carry the call to the backend and return the durable answer as the model-
 * facing JSON. A deterministic backend rejection (path rules, conflicts, non-zero
 * build diagnostics) arrives as data.error / exitCode content — an ordinary tool
 * result the model reads and acts on in the next round, not a thrown failure.
 */
export function createProjectTools(deps: ProjectToolDeps): Array<ToolDefinition> {
  let fatalCode: string | null = null;
  // In-flight dedup: a replayed toolCallId joins the promise of the call still
  // running, so one backend invocation serves both. After settling the entry is
  // dropped — a later replay is answered from the backend's durable ledger.
  const inFlight = new Map<string, Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolResult }>>();
  const invoke = (
    toolCallId: string,
    name: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolResult }> => {
    const running = inFlight.get(toolCallId);
    if (running) {
      return running;
    }
    const call = runToolCall(toolCallId, name, params, signal).finally(() => {
      inFlight.delete(toolCallId);
    });
    inFlight.set(toolCallId, call);
    return call;
  };
  const runToolCall = async (
    toolCallId: string,
    name: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolResult }> => {
    if (fatalCode !== null) {
      throw new BackendHttpError(0, fatalCode, "the task stopped after an unresolved tool outcome");
    }
    if (signal?.aborted) {
      throw new Error(`tool ${name} was aborted before it could run`);
    }
    let result: ToolResult;
    try {
      if (deps.beforeInvoke) await deps.beforeInvoke();
      if (signal?.aborted) throw new Error("tool was stopped before backend invocation");
      result = await deps.backend.invoke(deps.taskId, {
        toolCallId,
        name,
        expectedRevision: Number.parseInt(deps.getRevision(), 10) || 0,
        args: params,
      });
    } catch (error) {
      if (error instanceof BackendHttpError && ["AI_CALL_UNKNOWN", "AI_CALL_NEEDS_ATTENTION", "AI_APPLICATION_UNAVAILABLE", "AI_CONTEXT_UNAVAILABLE"].includes(error.code)) {
        fatalCode = error.code;
        deps.onFatal?.(fatalCode);
      }
      throw error;
    }
    deps.onResult?.(result);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    };
  };

  return [
    {
      name: "list_files",
      label: "List project files",
      description: "Lists a project directory through the Manao workspace. Entries are allowlisted; hidden and credential paths never appear.",
      parameters: directoryArgs,
      executionMode: "sequential",
      async execute(toolCallId, params: Static<typeof directoryArgs>, signal) {
        return await invoke(toolCallId, "list_files", { directory: params.directory ?? "" }, signal);
      },
    },
    {
      name: "read_file",
      label: "Read project file",
      description: "Reads one allowlisted project file (max 128 KiB) through the Manao workspace.",
      parameters: pathArgs,
      executionMode: "sequential",
      async execute(toolCallId, params: Static<typeof pathArgs>, signal) {
        return await invoke(toolCallId, "read_file", { path: params.path }, signal);
      },
    },
    {
      name: "write_file",
      label: "Write project file",
      description: "Writes one allowlisted project file through the Manao workspace and returns its new revision.",
      parameters: writeArgs,
      executionMode: "sequential",
      async execute(toolCallId, params: Static<typeof writeArgs>, signal) {
        const args: Record<string, unknown> = { path: params.path, content: params.content };
        if (params.expectedSha256 !== undefined) args["expectedSha256"] = params.expectedSha256;
        return await invoke(toolCallId, "write_file", args, signal);
      },
    },
    {
      name: "build",
      label: "Run project build",
      description: "Runs one fixed build goal (compile, test or package) in an isolated read-only copy and returns the real exit result with bounded diagnostics.",
      parameters: buildArgs,
      executionMode: "sequential",
      async execute(toolCallId, params: Static<typeof buildArgs>, signal) {
        return await invoke(toolCallId, "build", { goal: params.goal }, signal);
      },
    },
    {
      name: "application",
      label: "Control project application",
      description: "Starts, stops or observes this project application and reads its persisted log tail. Stop must be confirmed before editing or building.",
      parameters: applicationArgs,
      executionMode: "sequential",
      async execute(toolCallId, params: Static<typeof applicationArgs>, signal) {
        return await invoke(toolCallId, "application", params, signal);
      },
    },
    {
      name: "app_http_get",
      label: "Check project HTTP endpoint",
      description: "GET a relative path on the current ready project application. Returns the real HTTP status and bounded body; no arbitrary network target.",
      parameters: appHttpGetArgs,
      executionMode: "sequential",
      async execute(toolCallId, params: Static<typeof appHttpGetArgs>, signal) {
        return await invoke(toolCallId, "app_http_get", params, signal);
      },
    },
  ];
}
