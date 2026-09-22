export const DEFAULT_PROJECT_LIMIT = 8;

export type ProjectState = 'CREATING' | 'READY' | 'FAILED' | 'DELETING';

export type RuntimeTemplateId = 'java-console' | 'java-spring-boot-web';

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
