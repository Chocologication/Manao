import { createHash } from "node:crypto";

/** Backend-owned task snapshot. Its key and array ordering is part of the digest contract. */
export interface ProjectEnvironment {
  readonly schemaVersion: 1;
  readonly templateId: "java-console" | "java-spring-boot-web" | "python-console" | "python-fastapi-web"
    | "node-javascript-console" | "node-javascript-web" | "node-typescript-console" | "node-typescript-web";
  readonly language: "java" | "python" | "javascript" | "typescript";
  readonly framework: "none" | "spring-boot" | "fastapi";
  readonly executionKind: "task" | "service";
  readonly entrypoint: string;
  readonly pythonVersion: "3.13" | null;
  readonly primaryPort: number | null;
  readonly readinessPath: string | null;
  readonly mysql: boolean;
  readonly redis: boolean;
  readonly filePolicy: "java-v1" | "python-v1" | "node-v1";
  readonly buildGoals: readonly string[];
  readonly dependencyGroups: readonly string[];
  readonly tools: readonly string[];
}

const KEYS = ["schemaVersion", "templateId", "language", "framework", "executionKind", "entrypoint", "pythonVersion",
  "primaryPort", "readinessPath", "mysql", "redis", "filePolicy", "buildGoals", "dependencyGroups", "tools"] as const;
const TEMPLATES = ["java-console", "java-spring-boot-web", "python-console", "python-fastapi-web",
  "node-javascript-console", "node-javascript-web", "node-typescript-console", "node-typescript-web"] as const;

export function parseProjectEnvironment(value: unknown): ProjectEnvironment {
  const invalid = () => new Error("The task project environment is invalid");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(input, key))) throw invalid();
  if (typeof input.templateId !== "string" || !TEMPLATES.includes(input.templateId as typeof TEMPLATES[number])) throw invalid();
  const template = input.templateId as ProjectEnvironment["templateId"];
  const python = template.startsWith("python-");
  const node = template.startsWith("node-");
  const typescript = template.startsWith("node-typescript-");
  const service = template.endsWith("-web");
  if (typeof input.mysql !== "boolean" || typeof input.redis !== "boolean") throw invalid();
  if ((python || node) && !service && (input.mysql || input.redis)) throw invalid();
  if (service ? typeof input.primaryPort !== "number" || !Number.isInteger(input.primaryPort) || input.primaryPort < 1 || input.primaryPort > 65535
    : input.primaryPort !== null) throw invalid();
  const tools = ["list_files", "read_file", "write_file", "build", "application"];
  if (service) tools.push("app_http_get");
  tools.push("read_image");
  if (python) tools.push("python_dependencies");
  const environment: ProjectEnvironment = {
    schemaVersion: 1, templateId: template, language: node ? typescript ? "typescript" : "javascript" : python ? "python" : "java",
    framework: service && !node ? python ? "fastapi" : "spring-boot" : "none",
    executionKind: service ? "service" : "task",
    entrypoint: node ? typescript ? "src/main.ts" : "src/main.js" : python ? service ? "app.main:app" : "main.py" : "com.example.app.App",
    pythonVersion: python ? "3.13" : null,
    primaryPort: input.primaryPort as number | null,
    readinessPath: service ? python || node ? "/health/ready" : "/actuator/health" : null,
    mysql: input.mysql, redis: input.redis, filePolicy: node ? "node-v1" : python ? "python-v1" : "java-v1",
    buildGoals: Object.freeze(python ? ["compile", "test"] : ["compile", "test", "package"]),
    dependencyGroups: Object.freeze(python ? ["main", "test"] : []), tools: Object.freeze(tools),
  };
  for (const key of KEYS) {
    const expected = environment[key];
    const actual = input[key];
    if (Array.isArray(expected) ? !Array.isArray(actual) || actual.length !== expected.length || expected.some((item, index) => item !== actual[index])
      : actual !== expected) throw invalid();
  }
  return Object.freeze(environment);
}

export function environmentSha256(environment: ProjectEnvironment): string {
  return createHash("sha256").update(JSON.stringify(parseProjectEnvironment(environment)), "utf8").digest("hex");
}
