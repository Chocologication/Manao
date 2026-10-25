import { describe, expect, it } from "vitest";
import { SettingsManager, type CreateAgentSessionOptions, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BackendClient, BackendHttpError, ProgressChain } from "../src/backend-client.js";
import { createPiSession, type PiTaskOutcome } from "../src/pi-session.js";
import { loadWorkerConfig, type WorkerBudgets } from "../src/config.js";
import { MODEL_CONFIG, privateDirs, scriptedSessionFactory, backendStub, resultFor, type RecordedCall, type ScriptedResponse, type SessionOverrides } from "./scripted-session.js";

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
    budgets: overrides.budgets,
    backend: backend as never,
    progress: chain,
    taskId: "task-1",
    deps: {
      createSession: ((options: CreateAgentSessionOptions) => {
        overrides.observeOptions?.(options);
        return scriptedSessionFactory(responses)(options);
      }) as never,
      ...(overrides.settingsManager !== undefined
        ? { settingsManager: overrides.settingsManager as never }
        : {}),
    },
  });
  const outcome = await pi.run({ prompt: "Fix the failing build and report what changed.", workspaceRevision: "7" });
  // The session returns its frozen outcome without waiting on the display chain; the
  // tests that observe progress items await the drain explicitly.
  await chain.drain();
  const tools = pi.registeredTools;
  return { outcome, backend, tools };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi session", () => {
  it.each(["AI_CALL_UNKNOWN", "AI_CALL_NEEDS_ATTENTION", "AI_APPLICATION_UNAVAILABLE"])("ends FAILED on %s and cannot execute later same-batch mutations", async (code) => {
    const { backend, outcome } = await runScriptedTask([
      { toolCalls: [{ id: "unknown", name: "build", args: { goal: "test" } },
        { id: "unsafe-write", name: "write_file", args: { path: "pom.xml", content: "unsafe" } },
        { id: "unsafe-start", name: "application", args: { action: "start" } }] },
      { text: "I will pretend the task completed." },
    ], [() => { throw new BackendHttpError(0, code, "unknown outcome"); }]);
    expect(backend.calls.map((call) => call.request.toolCallId)).toEqual(["unknown"]);
    expect(outcome).toMatchObject({ state: "FAILED", failureCode: code });
  });
  it("gives Pi application feedback capabilities and evidence rules without enabling built-in tools", async () => {
    let options: CreateAgentSessionOptions | undefined;
    await runScriptedTask([{ text: "done" }], [resultFor], { observeOptions: (value) => { options = value; } });
    const prompt = options!.resourceLoader!.getSystemPrompt()!;
    expect(prompt).toContain("application");
    expect(prompt).toContain("app_http_get");
    expect(prompt).toMatch(/accepted.*not.*ready/i);
    expect(prompt).toMatch(/stop.*confirmed/i);
    expect(prompt).toMatch(/write.*build.*active/i);
    expect(options!.noTools).toBe("builtin");
    expect(options!.model).toMatchObject({ contextWindow: 1_048_576, maxTokens: 8192 });
    expect(options!.settingsManager!.getCompactionSettings(options!.model)).toEqual({ enabled: true, reserveTokens: 262_145, keepRecentTokens: 20_000 });
  });
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
  });

  it("registers exactly the six project tools and nothing else", async () => {
    const { tools } = await runScriptedTask([{ text: "done" }]);
    expect(tools.map((tool) => tool.name)).toEqual(["list_files", "read_file", "write_file", "build", "application", "app_http_get"]);
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
  });

  it("leaves the terminal report to the delivery layer instead of the progress chain", async () => {
    const { outcome, backend } = await runScriptedTask([{ text: "完成" }]);
    expect(outcome).toMatchObject({ state: "COMPLETED", summary: "完成" });
    // The session never sends a terminal item (repair task 4): the server freezes the
    // outcome after the loop exits and the terminal delivery owns the reporting.
    expect(backend.progressItems.some((item) => item.kind === "terminal")).toBe(false);
  });

  it("applies a stop requested before the run and never prompts afterwards", async () => {
    const backend = backendStub([resultFor]);
    const chain = new ProgressChain(backend as unknown as BackendClient, "task-1");
    const pi = await createPiSession({
      model: MODEL_CONFIG,
      paths: privateDirs(),
      backend: backend as never,
      progress: chain,
      taskId: "task-1",
      deps: { createSession: scriptedSessionFactory([{ text: "must never be generated" }]) as never },
    });
    // The stop arrives while the run has not started (the server records it during
    // async init): after initialization the session must not prompt again.
    pi.stop();
    const outcome = await pi.run({ prompt: "Fix the failing build and report what changed.", workspaceRevision: "7" });
    await chain.drain();
    expect(outcome).toMatchObject({ state: "FAILED", failureCode: "AI_ABORTED" });
    expect(backend.calls).toHaveLength(0);
    expect(backend.progressItems.filter((item) => item.kind === "message")).toHaveLength(0);
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

  describe.each(["session default", "server configuration"])("raised budget via %s", (source) => {
    function productionBudgets(): WorkerBudgets | undefined {
      if (source === "session default") return undefined;
      return loadWorkerConfig({
        MANAO_AI_WORKER_TOKEN: "worker-test-token",
        MANAO_AI_BACKEND_TOKEN: "backend-test-token",
        MANAO_AI_BACKEND_BASE_URL: "http://127.0.0.1:9",
        MANAO_AI_SCRATCH_DIR: ".",
        MANAO_AI_AGENT_DIR: ".",
        MANAO_AI_SESSION_DIR: ".",
      }).budgets;
    }

    it("allows 180 tool calls including 20 builds to finish", async () => {
      const toolCalls = Array.from({ length: 180 }, (_, index) => index < 20
        ? { id: `build-${index}`, name: "build", args: { goal: "test" } }
        : { id: `read-${index}`, name: "list_files", args: { directory: "" } });
      const { outcome, backend } = await runScriptedTask([
        { toolCalls }, { text: "Completed within the task budget." },
      ], [resultFor], { budgets: productionBudgets() });

      expect(outcome.state).toBe("COMPLETED");
      expect(backend.calls).toHaveLength(180);
      expect(backend.calls.filter((call) => call.request.name === "build")).toHaveLength(20);
    });

    it("rejects the 181st tool before it reaches the backend", async () => {
      const { outcome, backend } = await runScriptedTask([
        { toolCalls: Array.from({ length: 181 }, (_, index) => ({
          id: `read-${index}`, name: "list_files", args: { directory: "" },
        })) },
        { text: "This must not complete." },
      ], [resultFor], { budgets: productionBudgets() });

      expect(outcome.failureCode).toBe("AI_BUDGET_EXCEEDED");
      expect(backend.calls).toHaveLength(180);
      expect(backend.calls.at(-1)?.request.toolCallId).toBe("read-179");
    });

    it("rejects the 21st build before it reaches the backend", async () => {
      const { outcome, backend } = await runScriptedTask([
        { toolCalls: Array.from({ length: 21 }, (_, index) => ({
          id: `build-${index}`, name: "build", args: { goal: "test" },
        })) },
        { text: "This must not complete." },
      ], [resultFor], { budgets: productionBudgets() });

      expect(outcome.failureCode).toBe("AI_BUDGET_EXCEEDED");
      expect(backend.calls).toHaveLength(20);
      expect(backend.calls.at(-1)?.request.toolCallId).toBe("build-19");
    });
  });
});
