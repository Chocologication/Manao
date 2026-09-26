export const DEFAULT_PROJECT_LIMIT = 8;

export type ProjectState = 'CREATING' | 'READY' | 'FAILED' | 'DELETING';

export type RuntimeTemplateId =
  | 'java-console'
  | 'java-spring-boot-web'
  | 'python-console'
  | 'python-fastapi-web';

/**
 * Fixed metadata of the internal template enum, shared by the creation form and the
 * project card. `web` marks the templates that offer MySQL/Redis and public ports;
 * `defaultTargetPort` is the template's primary port (8080 Java, 8000 Python).
 */
export const RUNTIME_TEMPLATE_META: Record<
  RuntimeTemplateId,
  { label: string; web: boolean; defaultTargetPort: number }
> = {
  'java-console': { label: 'Java console', web: false, defaultTargetPort: 8080 },
  'java-spring-boot-web': { label: 'Java Spring Boot web', web: true, defaultTargetPort: 8080 },
  'python-console': { label: 'Python console', web: false, defaultTargetPort: 8000 },
  'python-fastapi-web': { label: 'Python FastAPI web', web: true, defaultTargetPort: 8000 },
};

/** Non-sensitive public port declaration; the first entry decides the primary port. */
export type ProjectPublicPort = {
  name: string;
  targetPort: number;
  publicPort: number;
};

export type ProjectRuntimeConfig = {
  templateId: RuntimeTemplateId;
  mysql: boolean;
  redis: boolean;
  publicPorts: ProjectPublicPort[];
};

export type ProjectEndpointState = 'NONE' | 'ASSIGNED' | 'UNKNOWN';

/** Live per-dependency readiness; a dependency that was never selected stays ABSENT. */
export type DependencyState =
  | 'ABSENT'
  | 'PROVISIONING'
  | 'READY'
  | 'UNAVAILABLE'
  | 'RECOVERY_REQUIRED';

export type ProjectDependenciesState = {
  mysql: DependencyState;
  redis: DependencyState;
};

/** One public access point; the URL needs a deployment-configured public entry host. */
export type ProjectEndpoint = {
  name: string;
  targetPort: number;
  publicPort: number;
  url: string | null;
};

export type ProjectSummary = {
  id: string;
  name: string;
  state: ProjectState;
  createdAt: string;
  failureReason: string | null;
  /** Present only on projects created with runtime configuration; legacy views omit it. */
  runtime?: ProjectRuntimeConfig;
  /** Present only on runtime-aware views; a missing field means the state is not exposed. */
  endpointState?: ProjectEndpointState;
  dependencies?: ProjectDependenciesState;
  endpoints?: ProjectEndpoint[];
};
export type ProjectListResponse = { items: ProjectSummary[]; limit: number };

/**
 * Wire body of POST /api/v1/projects. The template fields are optional so the legacy
 * name-only request keeps working (console default); the configured form always sends
 * them together with a creation key.
 */
export type CreateProjectRequest = {
  name: string;
  creationKey?: string;
  templateId?: RuntimeTemplateId;
  mysql?: boolean;
  redis?: boolean;
  publicPorts?: ProjectPublicPort[];
};
