/**
 * The worker-side projection of the task environment's project tools. Each execute()
 * only forwards to the backend's durable tool-call ledger. The worker never touches
 * the local filesystem, a shell, or any user code: this module imports nothing that
 * could, and every execution goes through {@link BackendClient.invoke}. The expected
 * revision is injected from worker-tracked state (WorkerStart plus every observed
 * tool result), never taken from model-supplied arguments.
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BackendHttpError, type BackendClient, type ToolResult } from "./backend-client.js";
import { parseProjectEnvironment, type ProjectEnvironment } from "./project-environment.js";

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

const dependencyArgs = Type.Object({
  action: Type.String({ enum: ["add", "remove"] }),
  packageName: Type.String({ minLength: 1, maxLength: 128, description: "A package name; no URL, path or command." }),
  version: Type.Optional(Type.String({ pattern: "^[0-9A-Za-z][0-9A-Za-z.+!-]{0,127}$", maxLength: 128,
    description: "Optional exact version for add, for example 8.4.2. No ranges or URLs. Omit for remove." })),
  group: Type.String({ enum: ["main", "test"] }),
}, { additionalProperties: false });

// Model providers require a top-level object. The backend remains authoritative
// for each action's required/allowed fields; the model sees those rules below.
const applicationArgs = Type.Object({
  action: Type.String({ enum: ["start", "status", "stop", "logs"] }),
  runId: Type.Optional(Type.String({ description: "Required for stop and logs; optional for status; omit for start. Use the exact Run ID from an earlier result." })),
  waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Only for status and stop. Integer seconds to wait, 0–10; omit for start and logs." })),
}, { additionalProperties: false });

const appHttpGetArgs = Type.Object({ runId: Type.String(), path: Type.String({ maxLength: 2048 }) }, { additionalProperties: false });
const imageArgs = Type.Object({attachmentId:Type.Optional(Type.String()),cursor:Type.Optional(Type.String())},{additionalProperties:false});

/**
 * Creates the applicable sequential tool definitions. The SDK runs the loop; these tools
 * only carry the call to the backend and return the durable answer as the model-
 * facing JSON. A deterministic backend rejection (path rules, conflicts, non-zero
 * build diagnostics) arrives as data.error / exitCode content — an ordinary tool
 * result the model reads and acts on in the next round, not a thrown failure.
 */
export function createProjectTools(deps: ProjectToolDeps, value: ProjectEnvironment): Array<ToolDefinition> {
  const environment = parseProjectEnvironment(value);
  const buildArgs = Type.Object({
    goal: Type.String({ enum: [...environment.buildGoals], description: "Fixed isolated validation goal; no arbitrary commands." }),
  }, { additionalProperties: false });
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

  const tools: ToolDefinition[] = [
    {
      name: "read_image", label: "Read conversation image",
      description: "Read an unexpired image by attachmentId. Use {} for the first conversation image catalog page, or {cursor} for later pages. Never pass both. Images remain readable after context compaction until their original deadline.",
      parameters: imageArgs,
      executionMode: "sequential",
      async execute(toolCallId,params: Static<typeof imageArgs>,signal) {
        if(Object.keys(params).length>1)throw new Error("Use attachmentId or cursor");
        return await invoke(toolCallId,"read_image",params,signal);
      },
    },
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
      description: environment.language === "python"
        ? "Validates an isolated copy: compile checks Python syntax only; test runs pytest and returns structured verificationStatus/testSummary. Syntax success is not a test pass."
        : "Runs compile, test or package with Maven in an isolated read-only copy and returns the real exit result and bounded diagnostics.",
      parameters: buildArgs,
      executionMode: "sequential",
      async execute(toolCallId, params: Static<typeof buildArgs>, signal) {
        if (!environment.buildGoals.includes(params.goal)) throw new Error("Unsupported build goal for the task environment");
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
    {
      name: "python_dependencies", label: "Change Python dependency",
      description: "Add or remove a Python dependency in main or test through the controlled uv workflow. Missing pytest/TestClient test dependencies belong in test. The backend owns project identity and operation reconciliation; never edit pyproject.toml or uv.lock manually.",
      parameters: dependencyArgs,
      executionMode: "sequential",
      async execute(toolCallId, params: Static<typeof dependencyArgs>, signal) {
        // Also enforce strict intent for direct callers; SDK validation alone is not authority.
        const keys = Object.keys(params);
        if (keys.some(key => !["action", "packageName", "version", "group"].includes(key))
          || !["add", "remove"].includes(params.action) || !["main", "test"].includes(params.group)
          || typeof params.packageName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(params.packageName)
          || (params.action === "remove" && Object.hasOwn(params, "version"))
          || (params.version !== undefined && (typeof params.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+!-]{0,127}$/.test(params.version)))) {
          throw new Error("Invalid Python dependency intent");
        }
        const args: Record<string, unknown> = { action: params.action, packageName: params.packageName, group: params.group };
        if (params.version !== undefined) args.version = params.version;
        return await invoke(toolCallId, "python_dependencies", args, signal);
      },
    },
  ];
  return environment.tools.map(name => tools.find(tool => tool.name === name)!);
}
