import { describe, expect, it, vi } from "vitest";
import { getSystemMessageText, type TranscriptContext } from "@earendil-works/pi-ai";
import { ProgressChain, BackendHttpError } from "../src/backend-client.js";
import { createPiSession } from "../src/pi-session.js";
import { parseProjectEnvironment, environmentSha256 } from "../src/project-environment.js";
import { JAVA_ENVIRONMENT, JAVA_CONSOLE, PYTHON_ENVIRONMENT, PYTHON_CONSOLE, PYTHON_SHA256 } from "./environment-fixtures.js";
import { backendStub, MODEL_CONFIG, privateDirs, scriptedSessionFactory, resultFor } from "./scripted-session.js";

describe("trusted project environment contract", () => {
  it("matches the backend canonical digest even when input property order differs", () => {
    const reversed = Object.fromEntries(Object.entries(PYTHON_ENVIRONMENT).reverse());
    expect(environmentSha256(parseProjectEnvironment(reversed))).toBe(PYTHON_SHA256);
    expect(parseProjectEnvironment(reversed)).toEqual(PYTHON_ENVIRONMENT);
  });
  it.each(Object.keys(PYTHON_ENVIRONMENT))("rejects missing %s instead of guessing defaults", key => {
    const value = { ...PYTHON_ENVIRONMENT }; delete value[key];
    expect(() => parseProjectEnvironment(value)).toThrow(/environment/i);
  });
  it.each([
    null, [], {}, { ...PYTHON_ENVIRONMENT, schemaVersion: 2 }, { ...PYTHON_ENVIRONMENT, ownerId: "injected" },
    { ...PYTHON_ENVIRONMENT, templateId: "python-new" }, { ...PYTHON_ENVIRONMENT, language: "java" },
    { ...PYTHON_ENVIRONMENT, framework: "spring-boot" }, { ...PYTHON_ENVIRONMENT, executionKind: "task" },
    { ...PYTHON_ENVIRONMENT, entrypoint: "main.py" }, { ...PYTHON_ENVIRONMENT, pythonVersion: "3.12" },
    { ...PYTHON_ENVIRONMENT, primaryPort: null }, { ...PYTHON_ENVIRONMENT, primaryPort: 65536 },
    { ...PYTHON_ENVIRONMENT, primaryPort: 1.5 }, { ...PYTHON_ENVIRONMENT, readinessPath: "/ready" },
    { ...PYTHON_ENVIRONMENT, mysql: "false" }, { ...PYTHON_ENVIRONMENT, redis: null },
    { ...PYTHON_ENVIRONMENT, filePolicy: "java-v1" }, { ...PYTHON_ENVIRONMENT, buildGoals: ["compile", "test", "package"] },
    { ...PYTHON_ENVIRONMENT, dependencyGroups: ["main"] }, { ...PYTHON_ENVIRONMENT, tools: [...PYTHON_ENVIRONMENT.tools, "bash"] },
    { ...JAVA_ENVIRONMENT, pythonVersion: "3.13" }, { ...PYTHON_CONSOLE, mysql: true },
    { ...PYTHON_CONSOLE, primaryPort: 8000 }, { ...JAVA_CONSOLE, readinessPath: "/actuator/health" },
  ])("rejects malformed or conflicting facts %#", value => {
    expect(() => parseProjectEnvironment(value)).toThrow(/environment/i);
  });
  it("rejects a missing environment before constructing a provider session", async () => {
    const createSession = vi.fn();
    await expect(createPiSession({ model: MODEL_CONFIG, paths: privateDirs(), taskId: "missing",
      backend: {} as never, progress: {} as never, deps: { createSession } } as never)).rejects.toThrow(/environment/i);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("environment at the real SDK provider boundary", () => {
  it.each([JAVA_ENVIRONMENT, JAVA_CONSOLE, PYTHON_ENVIRONMENT, PYTHON_CONSOLE])("sends only the current $templateId capabilities before and after tool execution", async environment => {
    const backend = backendStub([resultFor]);
    const requests: TranscriptContext[] = [];
    const pi = await createPiSession({ environment, model: MODEL_CONFIG, paths: privateDirs(), taskId: "env",
      backend: backend as never, progress: new ProgressChain(backend as never, "env"),
      deps: { createSession: async options => scriptedSessionFactory([
        { toolCalls: [{ id: "read", name: "read_file", args: { path: "README.md" } }] }, { text: "done" },
      ], context => { requests.push(structuredClone(context)); })(options) } });
    try {
      expect((await pi.run({ prompt: "inspect", workspaceRevision: "7" })).state).toBe("COMPLETED");
      expect(requests).toHaveLength(2);
      const active = new Map<string, unknown>();
      for (const request of requests) {
        const systemText = request.messages.filter(item => item.role === "system").map(item => getSystemMessageText(item)).join("\n");
        if (request === requests[0]) {
          expect(systemText).toContain(`"templateId":"${environment.templateId}"`);
          expect(systemText).toContain("current task environment takes precedence");
          if (environment.language === "python") {
            expect(systemText).toContain("checkKind=syntax");
            expect(systemText).toContain("checkKind=pytest");
            expect(systemText).toContain("reportComplete=true");
            expect(systemText).toContain("NO_SOURCE");
            expect(systemText).not.toMatch(/SYNTAX_ONLY|TESTS_PASSED/);
          }
        }
        for (const item of request.messages) if (item.role === "system") {
          for (const removed of item.toolsRemoved ?? []) active.delete(removed);
          for (const tool of item.toolsAdded ?? []) active.set(tool.name, tool.parameters);
        }
        expect([...active.keys()].sort()).toEqual([...environment.tools].sort());
        const build = active.get("build") as { properties: { goal: unknown } };
        expect(JSON.stringify(build.properties.goal)).toContain("compile");
        expect(JSON.stringify(build.properties.goal).includes("package")).toBe(environment.language === "java");
        if (environment.language === "python") {
          const schema = active.get("python_dependencies") as { additionalProperties: boolean; properties: Record<string, unknown> };
          expect(schema.additionalProperties).toBe(false);
          expect(Object.keys(schema.properties).sort()).toEqual(["action", "group", "packageName", "versionSpec"]);
        }
      }
    } finally { pi.dispose(); }
  });
  it("stops all later mutations after an unresolved Python dependency operation", async () => {
    const backend = backendStub([() => { throw new BackendHttpError(409, "AI_CALL_NEEDS_ATTENTION", "unknown"); }]);
    const pi = await createPiSession({ environment: PYTHON_ENVIRONMENT, model: MODEL_CONFIG, paths: privateDirs(), taskId: "deps",
      backend: backend as never, progress: new ProgressChain(backend as never, "deps"),
      deps: { createSession: async options => scriptedSessionFactory([{ toolCalls: [
        { id: "dependency", name: "python_dependencies", args: { action: "add", packageName: "pytest", group: "test" } },
        { id: "unsafe", name: "write_file", args: { path: "main.py", content: "unsafe" } },
      ] }, { text: "must not continue" }])(options) } });
    try {
      expect(await pi.run({ prompt: "add tests", workspaceRevision: "7" })).toMatchObject({ state: "FAILED", failureCode: "AI_CALL_NEEDS_ATTENTION" });
      expect(backend.calls.map(call => call.request.toolCallId)).toEqual(["dependency"]);
    } finally { pi.dispose(); }
  });
});
