import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { BackendHttpError, type ToolResult } from "../src/backend-client.js";
import { createProjectTools, TOOL_NAMES } from "../src/project-tools.js";

interface BackendStub {
  invoke: ReturnType<typeof vi.fn>;
}

function backendStub(results: ToolResult[] = []): BackendStub & { resultFor(name: string): ToolResult } {
  let index = 0;
  const invoke = vi.fn(async () => {
    const result = results[Math.min(index, results.length - 1)]!;
    index++;
    return result;
  });
  return {
    invoke,
    resultFor: () => results[0] ?? {
      toolCallId: "unknown", workspaceRevision: "8", data: {}, truncated: false,
    },
  } as never;
}

function toolResult(toolCallId: string, data: unknown): ToolResult {
  return { toolCallId, workspaceRevision: "8", data, truncated: false };
}

describe("worker project tools", () => {
  it.each(["AI_CALL_UNKNOWN", "AI_CALL_NEEDS_ATTENTION", "AI_APPLICATION_UNAVAILABLE"])("blocks later backend work after fatal %s even without an abort signal", async (code) => {
    const invoke = vi.fn().mockRejectedValueOnce(new BackendHttpError(0, code, "unknown outcome"))
      .mockResolvedValue(toolResult("later", {}));
    const onFatal = vi.fn();
    const tools = createProjectTools({ backend: { invoke } as never, taskId: "task-1", getRevision: () => "7", onFatal });
    await expect(tools.find((tool) => tool.name === "build")!.execute("first", { goal: "test" }, undefined, undefined, {} as never)).rejects.toBeInstanceOf(Error);
    for (const [name, args] of [["write_file", { path: "pom.xml", content: "unsafe" }], ["application", { action: "start" }]] as const) {
      await expect(tools.find((tool) => tool.name === name)!.execute("later", args, undefined, undefined, {} as never)).rejects.toBeInstanceOf(Error);
    }
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledExactlyOnceWith(code);
  });

  it("allows a later mediated repair after a decided validation rejection", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new BackendHttpError(422, "VALIDATION_ERROR", "invalid arguments"))
      .mockResolvedValue(toolResult("fixed", { path: "pom.xml" }));
    const onFatal = vi.fn();
    const tools = createProjectTools({ backend: { invoke } as never, taskId: "task-1", getRevision: () => "7", onFatal });
    const write = tools.find((tool) => tool.name === "write_file")!;
    await expect(write.execute("invalid", { path: "pom.xml", content: "x" }, undefined, undefined, {} as never)).rejects.toBeInstanceOf(Error);
    await write.execute("fixed", { path: "pom.xml", content: "fixed" }, undefined, undefined, {} as never);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(onFatal).not.toHaveBeenCalled();
  });
  it.each([
    ["application", { action: "start" }],
    ["application", { action: "status", runId: "run-1", waitSeconds: 10 }],
    ["application", { action: "stop", runId: "run-1", waitSeconds: 0 }],
    ["application", { action: "logs", runId: "run-1" }],
    ["app_http_get", { runId: "run-1", path: "/api/demo?name=Pi" }],
  ])("forwards %s arguments and tracked revision through the existing ledger", async (name, args) => {
    const expected = toolResult("call-app", { kind: name, runId: "run-1" });
    const backend = backendStub([expected]);
    const onResult = vi.fn();
    const tools = createProjectTools({ backend: backend as never, taskId: "task-1", getRevision: () => "13", onResult });
    const tool = tools.find((item) => item.name === name);
    expect(tool).toBeDefined();
    const outcome = await tool!.execute("call-app", args, undefined, undefined, {} as never);
    expect(backend.invoke).toHaveBeenCalledWith("task-1", { toolCallId: "call-app", name, expectedRevision: 13, args });
    expect(onResult).toHaveBeenCalledWith(expected);
    expect(outcome.details).toEqual(expected);
  });

  it("advertises application as a provider-compatible top-level object with bounded fields", () => {
    const tools = createProjectTools({ backend: backendStub() as never, taskId: "task-1", getRevision: () => "7" });
    const app = tools.find((tool) => tool.name === "application")!;
    expect(app).toBeDefined();
    const schema = JSON.parse(JSON.stringify(app.parameters));
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["action", "runId", "waitSeconds"]);
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties.action).toMatchObject({ type: "string", enum: ["start", "status", "stop", "logs"] });
    expect(schema.properties.runId.type).toBe("string");
    expect(schema.properties.waitSeconds).toMatchObject({ type: "integer", minimum: 0, maximum: 10 });
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    const http = tools.find((tool) => tool.name === "app_http_get")!.parameters as unknown as Record<string, any>;
    expect(http.additionalProperties).toBe(false);
    expect(http.required).toEqual(["runId", "path"]);
    expect(http.properties.path.maxLength).toBe(2048);
  });

  it("keeps action-specific requirements visible while forwarding backend rejections unchanged", async () => {
    const rejected = toolResult("call-missing-run", { error: { code: "VALIDATION_ERROR", message: "Request validation failed" } });
    const backend = backendStub([rejected]);
    const app = createProjectTools({ backend: backend as never, taskId: "task-1", getRevision: () => "13" })
      .find((tool) => tool.name === "application")!;
    const schema = JSON.parse(JSON.stringify(app.parameters));
    expect(schema.properties.runId.description).toMatch(/required.*stop.*logs/i);
    expect(schema.properties.waitSeconds.description).toMatch(/only.*status.*stop/i);
    const result = await app.execute("call-missing-run", { action: "stop" }, undefined, undefined, {} as never);
    expect(backend.invoke).toHaveBeenCalledWith("task-1", { toolCallId: "call-missing-run", name: "application", expectedRevision: 13, args: { action: "stop" } });
    expect(result.details).toEqual(rejected);
    expect(JSON.parse(result.content[0]!.text)).toEqual(rejected);
  });
  it("registers the six backend-mediated tools, each sequential", () => {
    const backend = backendStub();
    const tools = createProjectTools({ backend: backend as never, taskId: "task-1", getRevision: () => "7" });
    expect(tools.map((tool) => tool.name)).toEqual(["list_files", "read_file", "write_file", "build", "application", "app_http_get"]);
    for (const tool of tools) {
      expect(tool.executionMode).toBe("sequential");
    }
  });

  it("exposes no built-in file or shell tool surface", () => {
    const backend = backendStub();
    const tools = createProjectTools({ backend: backend as never, taskId: "task-1", getRevision: () => "7" });
    const names = tools.map((tool) => tool.name);
    for (const forbidden of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("forwards every execution through the backend client and never touches local user code", async () => {
    const backend = backendStub([
      toolResult("call-1", { path: "README.md", content: "hello", sha256: "a".repeat(64) }),
    ]);
    const tools = createProjectTools({ backend: backend as never, taskId: "task-1", getRevision: () => "7" });
    const read = tools.find((tool) => tool.name === "read_file")!;
    const outcome = await read.execute("call-1", { path: "README.md" }, undefined, undefined, {} as never);
    expect(backend.invoke).toHaveBeenCalledTimes(1);
    expect(backend.invoke).toHaveBeenCalledWith("task-1", {
      toolCallId: "call-1",
      name: "read_file",
      expectedRevision: 7,
      args: { path: "README.md" },
    });
    expect(JSON.parse(outcome.content[0]!.text)).toEqual({
      toolCallId: "call-1",
      workspaceRevision: "8",
      data: { path: "README.md", content: "hello", sha256: "a".repeat(64) },
      truncated: false,
    });
    // The module source imports nothing that could reach the local filesystem or a shell:
    // user code is only ever touched by the backend's workspace bridge.
    const source = readFileSync(new URL("../src/project-tools.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/node:(fs|child_process|os|fs\/promises)/);
  });

  it("injects the worker-tracked revision instead of trusting model args", async () => {
    const backend = backendStub([toolResult("call-2", { path: "README.md", sha256: "b".repeat(64) })]);
    let revision = "7";
    const tools = createProjectTools({ backend: backend as never, taskId: "task-1", getRevision: () => revision });
    const write = tools.find((tool) => tool.name === "write_file")!;
    await write.execute("call-2", { path: "README.md", content: "new text" }, undefined, undefined, {} as never);
    expect(backend.invoke.mock.calls[0]![1]!.expectedRevision).toBe(7);
    revision = "9";
    await write.execute("call-3", { path: "README.md", content: "more text" }, undefined, undefined, {} as never);
    expect(backend.invoke.mock.calls[1]![1]!.expectedRevision).toBe(9);
  });

  it("deduplicates a repeated tool call id while it is still in flight", async () => {
    let release: ((value: ToolResult) => void) | undefined;
    const invoke = vi.fn(async () => await new Promise<ToolResult>((resolve) => {
      release = resolve;
    }));
    const tools = createProjectTools({
      backend: { invoke } as never,
      taskId: "task-1",
      getRevision: () => "7",
    });
    const build = tools.find((tool) => tool.name === "build")!;
    const first = build.execute("call-same", { goal: "compile" }, undefined, undefined, {} as never);
    const second = build.execute("call-same", { goal: "compile" }, undefined, undefined, {} as never);
    release!(toolResult("call-same", { exitCode: 0 }));
    const [a, b] = await Promise.all([first, second]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(a.content).toEqual(b.content);
  });

  it("refuses to start a side effect after the abort signal fired", async () => {
    const backend = backendStub();
    const tools = createProjectTools({ backend: backend as never, taskId: "task-1", getRevision: () => "7" });
    const build = tools.find((tool) => tool.name === "build")!;
    const controller = new AbortController();
    controller.abort();
    await expect(build.execute("call-9", { goal: "compile" }, controller.signal, undefined, {} as never))
      .rejects.toThrow(/aborted/i);
    expect(backend.invoke).not.toHaveBeenCalled();
  });
});
