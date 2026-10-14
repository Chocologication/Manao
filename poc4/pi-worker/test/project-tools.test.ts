import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../src/backend-client.js";
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
  it("registers exactly the four backend-mediated tools, each sequential", () => {
    const backend = backendStub();
    const tools = createProjectTools({ backend: backend as never, taskId: "task-1", getRevision: () => "7" });
    expect(tools.map((tool) => tool.name)).toEqual(["list_files", "read_file", "write_file", "build"]);
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
