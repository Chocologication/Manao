import type {
  CleanupTransport,
  DeleteProject,
  ProjectView,
  ReadProject,
} from './contracts.ts';

export type HttpCleanupSession = {
  accessToken: string;
  userId: string;
};

export type HttpCleanupTransportOptions = {
  baseUrl: string;
  login(ownerKey: string): Promise<HttpCleanupSession>;
  fetchImpl?: typeof fetch;
};

export class HttpCleanupTransport implements CleanupTransport {
  private readonly baseUrl: string;
  private readonly login: (ownerKey: string) => Promise<HttpCleanupSession>;
  private readonly fetchImpl: typeof fetch;
  private readonly sessions = new Map<string, HttpCleanupSession>();
  createCalls = 0;
  deleteCalls = 0;
  dropCreateResponse = false;
  dropDeleteResponse = false;
  readonly failDeleteIds = new Set<string>();

  constructor(options: HttpCleanupTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.login = options.login;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  clearSessions(): void {
    this.sessions.clear();
  }

  async verifyOwner(ownerKey: string, expectedOwnerId: string): Promise<void> {
    const session = await this.session(ownerKey);
    if (session.userId !== expectedOwnerId) {
      throw new Error('OWNER_MISMATCH');
    }
  }

  async ownerId(ownerKey: string): Promise<string> {
    return (await this.session(ownerKey)).userId;
  }

  async createProject(ownerKey: string, exactName: string): Promise<ProjectView> {
    this.createCalls += 1;
    const response = await this.request(ownerKey, '/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ name: exactName }),
    });
    if (!response.ok) {
      throw this.classify(response.status, 'CREATE_REJECTED');
    }
    if (this.dropCreateResponse) {
      await response.text();
      throw new Error('TRANSPORT_UNCERTAIN');
    }
    return (await response.json()) as ProjectView;
  }

  async listProjects(ownerKey: string): Promise<ProjectView[]> {
    const response = await this.request(ownerKey, '/api/v1/projects');
    if (!response.ok) {
      throw this.classify(response.status, 'LIST_REJECTED');
    }
    const body = (await response.json()) as { items: ProjectView[] };
    return body.items;
  }

  async getProject(ownerKey: string, projectId: string): Promise<ReadProject> {
    const response = await this.request(ownerKey, '/api/v1/projects/' + encodeURIComponent(projectId));
    if (response.status === 404) {
      return { status: 404 };
    }
    if (!response.ok) {
      throw this.classify(response.status, 'GET_REJECTED');
    }
    return { status: 200, project: (await response.json()) as ProjectView };
  }

  async deleteProject(ownerKey: string, projectId: string, timeoutMs: number): Promise<DeleteProject> {
    this.deleteCalls += 1;
    if (this.failDeleteIds.has(projectId)) {
      throw new Error('INJECTED_DELETE_FAILURE');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.request(
        ownerKey,
        '/api/v1/projects/' + encodeURIComponent(projectId),
        { method: 'DELETE', signal: controller.signal },
      );
      if (response.status === 204 || response.status === 404 || response.status === 409 || response.status === 503) {
        let code: string | undefined;
        if (response.status === 409 || response.status === 503) {
          const body = (await response.json()) as { code?: string };
          code = body.code;
        }
        if (this.dropDeleteResponse) {
          throw new Error('TRANSPORT_UNCERTAIN');
        }
        return { status: response.status, code };
      }
      throw this.classify(response.status, 'DELETE_REJECTED');
    } finally {
      clearTimeout(timer);
    }
  }

  async getActiveRun(ownerKey: string, projectId: string): Promise<{ id: string; state: string } | null> {
    const response = await this.request(
      ownerKey,
      '/api/v1/projects/' + encodeURIComponent(projectId) + '/runs?limit=1',
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw this.classify(response.status, 'RUN_LOOKUP_REJECTED');
    }
    const body = (await response.json()) as { items?: Array<{ id: string; state: string; active?: boolean }> };
    const active = (body.items ?? []).find((run) => run.active === true
      || run.state === 'RUNNING'
      || run.state === 'STARTING'
      || run.state === 'STOPPING'
      || run.state === 'RECOVERING');
    return active ? { id: active.id, state: active.state } : null;
  }

  async stopRun(ownerKey: string, projectId: string, runId: string): Promise<void> {
    const response = await this.request(
      ownerKey,
      '/api/v1/projects/' + encodeURIComponent(projectId) + '/runs/' + encodeURIComponent(runId) + '/stop',
      { method: 'POST' },
    );
    if (!response.ok && response.status !== 409) {
      throw this.classify(response.status, 'STOP_REJECTED');
    }
  }

  private async session(ownerKey: string): Promise<HttpCleanupSession> {
    const existing = this.sessions.get(ownerKey);
    if (existing !== undefined) {
      return existing;
    }
    const created = await this.login(ownerKey);
    this.sessions.set(ownerKey, created);
    return created;
  }

  private async request(ownerKey: string, pathName: string, init: RequestInit = {}): Promise<Response> {
    const session = await this.session(ownerKey);
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + session.accessToken);
    headers.set('Accept', 'application/json');
    if (init.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await this.fetchImpl(this.baseUrl + pathName, { ...init, headers });
    if (response.status === 401) {
      this.sessions.delete(ownerKey);
      throw new Error('AUTH_FAILED');
    }
    return response;
  }

  private classify(status: number, fallback: string): Error {
    if (status === 401 || status === 403) {
      return new Error('AUTH_FAILED');
    }
    return new Error(fallback + ':' + status);
  }
}
