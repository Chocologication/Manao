import { readFileSync } from "node:fs";

// Independent backend contract fixtures; never derive expected values with worker code.
export const JAVA_ENVIRONMENT = {
  schemaVersion: 1, templateId: "java-spring-boot-web", language: "java", framework: "spring-boot",
  executionKind: "service", entrypoint: "com.example.app.App", pythonVersion: null,
  primaryPort: 8080, readinessPath: "/actuator/health", mysql: false, redis: false, filePolicy: "java-v1",
  buildGoals: ["compile", "test", "package"], dependencyGroups: [],
  tools: ["list_files", "read_file", "write_file", "build", "application", "app_http_get", "read_image"],
} as const;
export const PYTHON_ENVIRONMENT = JSON.parse(readFileSync(new URL("../../fixtures/agent-project-environment/python-fastapi-web.json", import.meta.url), "utf8"));
export const PYTHON_SHA256 = "b01fa3652c6ce9af1b816a24b783f6c6e12fbfe0716c1de6b05be43772899ea0";
export const NODE_ENVIRONMENT = JSON.parse(readFileSync(new URL("../../fixtures/agent-project-environment/node-typescript-web.json", import.meta.url), "utf8"));
export const NODE_SHA256 = "426df595096c2e3e74c9e1fd09ff775731c847c67dce83f5354e5f3281746759";
export const NODE_ENVIRONMENTS = ["javascript", "typescript"].flatMap(language => [true, false].map(service => ({
  ...NODE_ENVIRONMENT, templateId: `node-${language}-${service ? "web" : "console"}`, language,
  executionKind: service ? "service" : "task", entrypoint: `src/main.${language === "typescript" ? "ts" : "js"}`,
  primaryPort: service ? 3000 : null, readinessPath: service ? "/health/ready" : null,
  tools: NODE_ENVIRONMENT.tools.filter((name: string) => service || name !== "app_http_get"),
})));
export const JAVA_CONSOLE = { ...JAVA_ENVIRONMENT, templateId: "java-console", framework: "none", executionKind: "task",
  primaryPort: null, readinessPath: null, tools: ["list_files", "read_file", "write_file", "build", "application", "read_image"] } as const;
export const PYTHON_CONSOLE = { ...PYTHON_ENVIRONMENT, templateId: "python-console", framework: "none", executionKind: "task",
  entrypoint: "main.py", primaryPort: null, readinessPath: null,
  tools: ["list_files", "read_file", "write_file", "build", "application", "read_image", "python_dependencies"] };

export const JAVA_SHA256 = "e31dbbb89a4ba438265b8b2fed522cdd1099fc1478c209256e22534d8a5aae5f";
