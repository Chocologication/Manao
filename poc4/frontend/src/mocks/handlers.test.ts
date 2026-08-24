import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../contracts/api';
import type { LoginResponse } from '../contracts/auth';
import {
  parseCreateEntryResponse,
  parseDeleteEntryResponse,
  parseFileContentResponse,
  parseFileMetadata,
  parseFileTreeResponse,
  parseRenameEntryResponse,
  parseSaveFileResponse,
} from '../contracts/file';
import type { ProjectListResponse, ProjectSummary } from '../contracts/project';
import {
  parseCreateTerminalSessionResponse,
  parseTerminalAuditListResponse,
} from '../contracts/terminal';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../features/files/pathPolicy';
import {
  getActiveRun,
  getRunScenario,
  installVirtualRunClock,
  MOCK_RUN_PERSISTENCE_KEY,
  startRun,
  transitionRun,
} from './runState';
import {
  getFileRequestCount,
  resetMockState,
  setLargeFileBodiesEnabled,
  WRITE_SCENARIO_DELAY_MS,
} from './state';
import {
  getLiveTerminalSession,
  getTerminalScenario,
  seedTerminalAuditFixtures,
} from './terminalState';

const ALICE = { username: 'alice', password: 'demo-pass' };
const BOB = { username: 'bob', password: 'demo-pass' };
const ALICE_SEED_PROJECT_ID = 'prj-alice-notebook';
const BOB_SEED_PROJECT_ID = 'prj-bob-lab';
const MOCK_FAILURE_REASON = 'Mock workspace provisioning failed';
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

function bearerHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function postLogin(username: string, password: string): Promise<Response> {
  return fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

async function loginOk(username: string, password: string): Promise<LoginResponse> {
  const response = await postLogin(username, password);
  expect(response.status).toBe(200);
  return (await response.json()) as LoginResponse;
}

async function listProjects(token: string): Promise<Response> {
  return fetch('/api/v1/projects', { headers: bearerHeaders(token) });
}

async function getProject(token: string, projectId: string): Promise<Response> {
  return fetch(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
    headers: bearerHeaders(token),
  });
}

async function createProject(token: string, name: string): Promise<Response> {
  return fetch('/api/v1/projects', {
    method: 'POST',
    headers: {
      ...bearerHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function fileResourceUrl(
  projectId: string,
  resource: 'tree' | 'meta' | 'content' | 'download',
  path: string,
): string {
  const search = new URLSearchParams();
  search.set('path', path);
  return `/api/v1/projects/${encodeURIComponent(projectId)}/files/${resource}?${search.toString()}`;
}

async function fetchFileResource(
  token: string,
  projectId: string,
  resource: 'tree' | 'meta' | 'content' | 'download',
  path: string,
): Promise<Response> {
  const headers: HeadersInit =
    resource === 'download'
      ? { Accept: 'application/octet-stream', Authorization: `Bearer ${token}` }
      : bearerHeaders(token);
  return fetch(fileResourceUrl(projectId, resource, path), { headers });
}

function leakPattern(): RegExp {
  return /bob|not found|does not exist|prj-bob|lab-notes|usr-bob|pvc|pod|job|\\\\DeepLearning|C:\\\\|D:\\\\|\/Users\/|\/home\/|\/etc\/|\/var\/|physical/i;
}

async function expectGenericForbidden(response: Response): Promise<ApiErrorBody> {
  expect(response.status).toBe(403);
  const body = await readJson<ApiErrorBody>(response);
  expect(body.code).toBe('FORBIDDEN');
  expect(body.message).toBe('Access denied');
  expect(body.traceId).toEqual(expect.any(String));
  expect(body.message).not.toMatch(leakPattern());
  expect(JSON.stringify(body)).not.toMatch(leakPattern());
  expect(body).not.toHaveProperty('content');
  return body;
}

async function expectApiError(
  response: Response,
  status: number,
  code: ApiErrorBody['code'],
): Promise<ApiErrorBody> {
  expect(response.status).toBe(status);
  const body = await readJson<ApiErrorBody>(response);
  expect(body.code).toBe(code);
  expect(body.message).toEqual(expect.any(String));
  expect(body.traceId).toEqual(expect.any(String));
  expect(body).not.toHaveProperty('content');
  expect(JSON.stringify(body)).not.toMatch(
    /\\\\DeepLearning|C:\\\\Windows|\/Users\/|\/etc\/passwd|physical/i,
  );
  return body;
}

const SEED_REVISION = 'mock-rev-0001';
const README_CONTENT = '# Alice Notebook\n\nRead-only Maven demo.\n';
const APP_JAVA_PATH = 'src/main/java/demo/App.java';
const MIB = 1024 * 1024;

function projectEntriesUrl(projectId: string, suffix = '', path?: string): string {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/entries${suffix}`;
  if (path === undefined) {
    return base;
  }
  const search = new URLSearchParams();
  search.set('path', path);
  return `${base}?${search.toString()}`;
}

async function readTree(token: string, projectId: string, directory = '') {
  const response = await fetchFileResource(token, projectId, 'tree', directory);
  expect(response.status).toBe(200);
  return parseFileTreeResponse(await response.json(), parseProjectDirectoryPath(directory));
}

async function putFileContent(
  token: string,
  projectId: string,
  path: string,
  content: string,
  expectedWorkspaceRevision: string,
): Promise<Response> {
  return fetch(fileResourceUrl(projectId, 'content', path), {
    method: 'PUT',
    headers: {
      ...bearerHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content, expectedWorkspaceRevision }),
  });
}

async function postCreateEntry(
  token: string,
  projectId: string,
  kind: 'file' | 'directory',
  path: string,
  expectedWorkspaceRevision: string,
): Promise<Response> {
  return fetch(projectEntriesUrl(projectId), {
    method: 'POST',
    headers: {
      ...bearerHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ kind, path, expectedWorkspaceRevision }),
  });
}

async function postRenameEntry(
  token: string,
  projectId: string,
  path: string,
  nextPath: string,
  expectedWorkspaceRevision: string,
): Promise<Response> {
  return fetch(projectEntriesUrl(projectId, '/rename'), {
    method: 'POST',
    headers: {
      ...bearerHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path, nextPath, expectedWorkspaceRevision }),
  });
}

async function deleteProjectEntry(
  token: string,
  projectId: string,
  path: string,
  expectedWorkspaceRevision: string,
): Promise<Response> {
  return fetch(projectEntriesUrl(projectId, '', path), {
    method: 'DELETE',
    headers: {
      ...bearerHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedWorkspaceRevision }),
  });
}

async function postWriteScenario(token: string, scenario: string): Promise<Response> {
  return fetch('/api/v1/session/write-scenario', {
    method: 'POST',
    headers: {
      ...bearerHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ scenario }),
  });
}

async function expectSeedWorkspaceUnchanged(token: string, projectId: string): Promise<void> {
  const tree = await readTree(token, projectId, '');
  expect(tree.workspaceRevision).toBe(SEED_REVISION);
  expect(tree.entries.map((entry) => entry.name).sort()).toEqual([
    '.gitignore',
    'README.md',
    'assets',
    'docs',
    'pom.xml',
    'src',
  ]);
  const readme = await fetchFileResource(token, projectId, 'content', 'README.md');
  expect(readme.status).toBe(200);
  const body = parseFileContentResponse(
    await readme.json(),
    parseProjectRelativePath('README.md'),
  );
  expect(body.content).toBe(README_CONTENT);
  expect(body.workspaceRevision).toBe(SEED_REVISION);
}

describe('MSW auth handlers', () => {
  it('returns a 15-minute expiry on successful login', async () => {
    const before = Date.now();
    const body = await loginOk(ALICE.username, ALICE.password);
    const after = Date.now();

    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.accessToken.length).toBeGreaterThan(0);
    expect(body.user).toEqual({ id: 'usr-alice', username: 'alice' });
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + ACCESS_TOKEN_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + ACCESS_TOKEN_TTL_MS);
  });

  it('returns 401 UNAUTHENTICATED for invalid credentials', async () => {
    const response = await postLogin(ALICE.username, 'wrong-pass');
    expect(response.status).toBe(401);
    const body = await readJson<ApiErrorBody>(response);
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(body.message).toEqual(expect.any(String));
    expect(body.traceId).toEqual(expect.any(String));
  });

  it('returns 401 on protected routes when the token is missing, unknown, or expired', async () => {
    const missing = await fetch('/api/v1/projects', { headers: { Accept: 'application/json' } });
    expect(missing.status).toBe(401);

    const unknown = await fetch('/api/v1/projects', {
      headers: bearerHeaders('tok-unknown'),
    });
    expect(unknown.status).toBe(401);

    vi.useFakeTimers({ toFake: ['Date'] });
    const session = await loginOk(ALICE.username, ALICE.password);
    vi.advanceTimersByTime(ACCESS_TOKEN_TTL_MS + 1);
    const expired = await listProjects(session.accessToken);
    expect(expired.status).toBe(401);

    const missingBody = await readJson<ApiErrorBody>(missing);
    const unknownBody = await readJson<ApiErrorBody>(unknown);
    const expiredBody = await readJson<ApiErrorBody>(expired);
    expect(missingBody.code).toBe('UNAUTHENTICATED');
    expect(unknownBody.code).toBe('UNAUTHENTICATED');
    expect(expiredBody.code).toBe('UNAUTHENTICATED');
  });

  it('makes the next list GET 401 after the current token is expired', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    expect((await listProjects(alice.accessToken)).status).toBe(200);

    const expire = await fetch('/api/v1/session/expire', {
      method: 'POST',
      headers: bearerHeaders(alice.accessToken),
    });
    expect(expire.status).toBe(204);

    const listed = await listProjects(alice.accessToken);
    expect(listed.status).toBe(401);
    const body = await readJson<ApiErrorBody>(listed);
    expect(body.code).toBe('UNAUTHENTICATED');
  });
});

describe('MSW project handlers', () => {
  it('lists only the authenticated owner projects', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const bob = await loginOk(BOB.username, BOB.password);

    const aliceListResponse = await listProjects(alice.accessToken);
    const bobListResponse = await listProjects(bob.accessToken);
    expect(aliceListResponse.status).toBe(200);
    expect(bobListResponse.status).toBe(200);

    const aliceList = await readJson<ProjectListResponse>(aliceListResponse);
    const bobList = await readJson<ProjectListResponse>(bobListResponse);

    expect(aliceList.limit).toBe(3);
    expect(bobList.limit).toBe(3);
    expect(aliceList.items.map((item) => item.id)).toEqual([ALICE_SEED_PROJECT_ID]);
    expect(bobList.items.map((item) => item.id)).toEqual([BOB_SEED_PROJECT_ID]);
    expect(aliceList.items.map((item) => item.id)).not.toContain(BOB_SEED_PROJECT_ID);
    expect(bobList.items.map((item) => item.id)).not.toContain(ALICE_SEED_PROJECT_ID);
  });

  it('returns the same generic 403 FORBIDDEN for another owner and an unknown id', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);

    const foreign = await getProject(alice.accessToken, BOB_SEED_PROJECT_ID);
    const unknown = await getProject(alice.accessToken, 'prj-does-not-exist');

    expect(foreign.status).toBe(403);
    expect(unknown.status).toBe(403);

    const foreignBody = await readJson<ApiErrorBody>(foreign);
    const unknownBody = await readJson<ApiErrorBody>(unknown);
    expect(foreignBody.code).toBe('FORBIDDEN');
    expect(unknownBody.code).toBe('FORBIDDEN');
    expect(foreignBody.message).toBe(unknownBody.message);
    expect(foreignBody.message).not.toMatch(/bob|not found|does not exist|prj-bob|exist/i);
  });

  it('creates with 202 CREATING then becomes READY after two observing GETs, exactly once', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const createdResponse = await createProject(alice.accessToken, 'Alpha');
    expect(createdResponse.status).toBe(202);
    const created = await readJson<ProjectSummary>(createdResponse);
    expect(created.id).toMatch(/^prj-/);
    expect(created.state).toBe('CREATING');
    expect(created.failureReason).toBeNull();

    const first = await readJson<ProjectSummary>(await getProject(alice.accessToken, created.id));
    expect(first.state).toBe('CREATING');

    const second = await readJson<ProjectSummary>(await getProject(alice.accessToken, created.id));
    expect(second.state).toBe('READY');
    expect(second.failureReason).toBeNull();

    const third = await readJson<ProjectSummary>(await getProject(alice.accessToken, created.id));
    expect(third).toEqual(second);
    expect(third.state).toBe('READY');
  });

  it('counts a list GET that includes the project as one observation', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const created = await readJson<ProjectSummary>(
      await createProject(alice.accessToken, 'Listed'),
    );
    expect(created.state).toBe('CREATING');

    const firstList = await readJson<ProjectListResponse>(await listProjects(alice.accessToken));
    expect(firstList.items.find((item) => item.id === created.id)?.state).toBe('CREATING');

    const secondList = await readJson<ProjectListResponse>(await listProjects(alice.accessToken));
    expect(secondList.items.find((item) => item.id === created.id)?.state).toBe('READY');
  });

  it('fails names that start with fail- after two observing queries', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const created = await readJson<ProjectSummary>(
      await createProject(alice.accessToken, 'fail-demo'),
    );
    expect(created.state).toBe('CREATING');

    const first = await readJson<ProjectSummary>(await getProject(alice.accessToken, created.id));
    expect(first.state).toBe('CREATING');

    const second = await readJson<ProjectSummary>(await getProject(alice.accessToken, created.id));
    expect(second.state).toBe('FAILED');
    expect(second.failureReason).toBe(MOCK_FAILURE_REASON);

    const third = await readJson<ProjectSummary>(await getProject(alice.accessToken, created.id));
    expect(third.state).toBe('FAILED');
    expect(third.failureReason).toBe(MOCK_FAILURE_REASON);
  });

  it('rejects a fourth project with 409 even when the UI is bypassed', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const second = await createProject(alice.accessToken, 'Two');
    const third = await createProject(alice.accessToken, 'Three');
    expect(second.status).toBe(202);
    expect(third.status).toBe(202);

    const fourth = await createProject(alice.accessToken, 'Four');
    expect(fourth.status).toBe(409);
    const body = await readJson<ApiErrorBody>(fourth);
    expect(body.code).toBe('PROJECT_LIMIT_REACHED');
    expect(body.message).toEqual(expect.any(String));
    expect(body.traceId).toEqual(expect.any(String));
  });
});

describe('MSW read-only file handlers', () => {
  it('lists only direct children at the Alice Maven root, including hidden files', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const response = await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'tree', '');
    expect(response.status).toBe(200);
    const tree = parseFileTreeResponse(await response.json(), parseProjectDirectoryPath(''));
    expect(tree.workspaceRevision).toBe(SEED_REVISION);
    const names = tree.entries.map((entry) => entry.name).sort();
    expect(names).toEqual(['.gitignore', 'README.md', 'assets', 'docs', 'pom.xml', 'src']);
    expect(tree.entries.find((entry) => entry.name === '.gitignore')).toMatchObject({
      path: '.gitignore',
      kind: 'file',
      hidden: true,
      hasChildren: null,
    });
    expect(tree.entries.find((entry) => entry.name === 'src')).toMatchObject({
      kind: 'directory',
      hidden: false,
      sizeBytes: null,
      hasChildren: true,
    });
    expect(tree.entries.some((entry) => entry.name === 'App.java')).toBe(false);
    expect(tree.entries.some((entry) => entry.path.includes('/'))).toBe(false);
  });

  it('lists only direct children of src and includes Java files under demo', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const srcResponse = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'tree',
      'src',
    );
    expect(srcResponse.status).toBe(200);
    const srcTree = parseFileTreeResponse(
      await srcResponse.json(),
      parseProjectDirectoryPath('src'),
    );
    expect(srcTree.entries.map((entry) => entry.name).sort()).toEqual(['main', 'test']);
    expect(srcTree.entries.every((entry) => entry.kind === 'directory')).toBe(true);
    expect(srcTree.entries.some((entry) => entry.name === 'App.java')).toBe(false);

    const demoResponse = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'tree',
      'src/main/java/demo',
    );
    expect(demoResponse.status).toBe(200);
    const demoTree = parseFileTreeResponse(
      await demoResponse.json(),
      parseProjectDirectoryPath('src/main/java/demo'),
    );
    expect(demoTree.entries.map((entry) => entry.name).sort()).toEqual(['App.java', 'NearLimit.java']);
    expect(demoTree.entries.every((entry) => entry.kind === 'file')).toBe(true);
  });

  it('returns MONACO_TEXT metadata for ordinary Maven text files within 20 MiB', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    for (const path of ['pom.xml', 'src/main/java/demo/App.java', 'README.md']) {
      const response = await fetchFileResource(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'meta',
        path,
      );
      expect(response.status).toBe(200);
      const meta = parseFileMetadata(await response.json(), parseProjectRelativePath(path));
      expect(meta.renderMode).toBe('MONACO_TEXT');
      expect(meta.blockReason).toBeNull();
      expect(meta.encoding).toBe('UTF-8');
      expect(meta.sizeBytes).toBeGreaterThan(0);
      expect(meta.sizeBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
    }
  });

  it('uses exact size-gate metadata for 20 MiB, 20 MiB+1, 50 MiB and 50 MiB+1', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const cases = [
      {
        path: 'src/main/java/demo/NearLimit.java',
        sizeBytes: 20 * 1024 * 1024 - 1,
        renderMode: 'MONACO_TEXT' as const,
        blockReason: null,
      },
      {
        path: 'docs/exact-20mib.md',
        sizeBytes: 20 * 1024 * 1024,
        renderMode: 'MONACO_TEXT' as const,
        blockReason: null,
      },
      {
        path: 'docs/large-notes.md',
        sizeBytes: 20 * 1024 * 1024 + 1,
        renderMode: 'PLAIN_TEXT' as const,
        blockReason: null,
      },
      {
        path: 'docs/exact-50mib.md',
        sizeBytes: 50 * 1024 * 1024,
        renderMode: 'PLAIN_TEXT' as const,
        blockReason: null,
      },
      {
        path: 'docs/too-large.md',
        sizeBytes: 50 * 1024 * 1024 + 1,
        renderMode: 'BLOCKED' as const,
        blockReason: 'FILE_TOO_LARGE' as const,
      },
    ];
    for (const item of cases) {
      const response = await fetchFileResource(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'meta',
        item.path,
      );
      expect(response.status).toBe(200);
      const meta = parseFileMetadata(await response.json(), parseProjectRelativePath(item.path));
      expect(meta.sizeBytes).toBe(item.sizeBytes);
      expect(meta.renderMode).toBe(item.renderMode);
      expect(meta.blockReason).toBe(item.blockReason);
    }
  });

  it('blocks binary and non-UTF-8 fixtures in metadata', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const pngResponse = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'meta',
      'assets/logo.png',
    );
    expect(pngResponse.status).toBe(200);
    const png = parseFileMetadata(await pngResponse.json(), parseProjectRelativePath('assets/logo.png'));
    expect(png.renderMode).toBe('BLOCKED');
    expect(png.blockReason).toBe('BINARY_FILE');
    expect(png.encoding).toBeNull();
    expect(png.mediaType).toBe('image/png');

    const latinResponse = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'meta',
      'docs/latin1.txt',
    );
    expect(latinResponse.status).toBe(200);
    const latin = parseFileMetadata(
      await latinResponse.json(),
      parseProjectRelativePath('docs/latin1.txt'),
    );
    expect(latin.renderMode).toBe('BLOCKED');
    expect(latin.blockReason).toBe('UNSUPPORTED_ENCODING');
    expect(latin.encoding).toBeNull();
  });

  it('returns content and workspaceRevision for MONACO_TEXT and PLAIN_TEXT without huge bodies', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const javaResponse = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'content',
      'src/main/java/demo/App.java',
    );
    expect(javaResponse.status).toBe(200);
    const java = parseFileContentResponse(
      await javaResponse.json(),
      parseProjectRelativePath('src/main/java/demo/App.java'),
    );
    expect(java.content).toContain('class App');
    expect(java.workspaceRevision.length).toBeGreaterThan(0);

    const nearLimitResponse = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'content',
      'src/main/java/demo/NearLimit.java',
    );
    expect(nearLimitResponse.status).toBe(200);
    const nearLimit = parseFileContentResponse(
      await nearLimitResponse.json(),
      parseProjectRelativePath('src/main/java/demo/NearLimit.java'),
    );
    expect(nearLimit.content.length).toBeLessThan(10_000);
    expect(nearLimit.content.length).not.toBe(20 * 1024 * 1024 - 1);

    const largeNotesResponse = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'content',
      'docs/large-notes.md',
    );
    expect(largeNotesResponse.status).toBe(200);
    const largeNotes = parseFileContentResponse(
      await largeNotesResponse.json(),
      parseProjectRelativePath('docs/large-notes.md'),
    );
    expect(largeNotes.content.length).toBeLessThan(10_000);
    expect(largeNotes.content.length).not.toBe(20 * 1024 * 1024 + 1);

    const exact20Response = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'content',
      'docs/exact-20mib.md',
    );
    expect(exact20Response.status).toBe(200);
    const exact20 = parseFileContentResponse(
      await exact20Response.json(),
      parseProjectRelativePath('docs/exact-20mib.md'),
    );
    expect(exact20.content.length).toBeLessThan(10_000);

    const exact50Response = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'content',
      'docs/exact-50mib.md',
    );
    expect(exact50Response.status).toBe(200);
    const exact50 = parseFileContentResponse(
      await exact50Response.json(),
      parseProjectRelativePath('docs/exact-50mib.md'),
    );
    expect(exact50.content.length).toBeLessThan(10_000);
  });

  it('rejects content for binary, too-large and non-UTF-8 files without leaking bodies', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    await expectApiError(
      await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'content', 'assets/logo.png'),
      415,
      'BINARY_FILE',
    );
    await expectApiError(
      await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'content', 'docs/too-large.md'),
      413,
      'FILE_TOO_LARGE',
    );
    const encoding = await expectApiError(
      await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'content', 'docs/latin1.txt'),
      400,
      'VALIDATION_ERROR',
    );
    expect(JSON.stringify(encoding)).not.toMatch(/latin-?1|ISO-8859|encoding/i);
  });

  it('downloads fixture bytes with a sanitized Content-Disposition filename', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const pom = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'download',
      'pom.xml',
    );
    expect(pom.status).toBe(200);
    expect(pom.headers.get('Content-Disposition')).toMatch(/filename="pom.xml"/i);
    expect(pom.headers.get('Content-Disposition')).not.toMatch(/[/\\]/);
    const pomBytes = new Uint8Array(await pom.arrayBuffer());
    expect(pomBytes.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder('utf-8').decode(pomBytes)).toContain('<artifactId>demo</artifactId>');

    const png = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'download',
      'assets/logo.png',
    );
    expect(png.status).toBe(200);
    expect(png.headers.get('Content-Disposition')).toMatch(/filename="logo.png"/i);
    const pngBytes = new Uint8Array(await png.arrayBuffer());
    expect(Array.from(pngBytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const tooLarge = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'download',
      'docs/too-large.md',
    );
    expect(tooLarge.status).toBe(200);
    expect((await tooLarge.arrayBuffer()).byteLength).toBeLessThan(10_000);

    const latin = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'download',
      'docs/latin1.txt',
    );
    expect(latin.status).toBe(200);
    expect(Array.from(new Uint8Array(await latin.arrayBuffer()))).toContain(0xe9);
  });

  it('uses the same generic 403 for another owner, unknown ids and non-READY projects', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const bob = await loginOk(BOB.username, BOB.password);

    const foreignTree = await expectGenericForbidden(
      await fetchFileResource(alice.accessToken, BOB_SEED_PROJECT_ID, 'tree', ''),
    );
    const unknownMeta = await expectGenericForbidden(
      await fetchFileResource(alice.accessToken, 'prj-does-not-exist', 'meta', 'README.md'),
    );
    expect(foreignTree.message).toBe(unknownMeta.message);

    const bobOwn = await fetchFileResource(bob.accessToken, BOB_SEED_PROJECT_ID, 'tree', '');
    expect(bobOwn.status).toBe(200);
    const bobTree = parseFileTreeResponse(await bobOwn.json(), parseProjectDirectoryPath(''));
    expect(bobTree.entries.map((entry) => entry.name)).not.toContain('pom.xml');
    expect(bobTree.entries.some((entry) => entry.path.startsWith('src/'))).toBe(false);

    const created = await readJson<ProjectSummary>(
      await createProject(alice.accessToken, 'NotReadyYet'),
    );
    expect(created.state).toBe('CREATING');
    await expectGenericForbidden(
      await fetchFileResource(alice.accessToken, created.id, 'tree', ''),
    );
    const first = await readJson<ProjectSummary>(await getProject(alice.accessToken, created.id));
    expect(first.state).toBe('CREATING');
    const second = await readJson<ProjectSummary>(await getProject(alice.accessToken, created.id));
    expect(second.state).toBe('READY');

    const failed = await readJson<ProjectSummary>(
      await createProject(alice.accessToken, 'fail-files'),
    );
    await getProject(alice.accessToken, failed.id);
    await getProject(alice.accessToken, failed.id);
    await expectGenericForbidden(
      await fetchFileResource(alice.accessToken, failed.id, 'content', 'README.md'),
    );
  });

  it('returns 400 INVALID_PATH for malformed relative paths without echoing them', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const malformed = [
      '/etc/passwd',
      '../secret',
      'src\\App.java',
      'C:/Windows/file.txt',
      'foo/../bar',
      'foo//bar',
      '.',
      '..',
      'foo/./bar',
    ];
    for (const path of malformed) {
      const response = await fetchFileResource(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'content',
        path,
      );
      const body = await expectApiError(response, 400, 'INVALID_PATH');
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(path);
      expect(serialized).not.toMatch(/\/etc\/passwd|Windows|App\.java|\.\.\/secret/i);
    }

    const emptyFile = await expectApiError(
      await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'meta', ''),
      400,
      'INVALID_PATH',
    );
    expect(JSON.stringify(emptyFile)).not.toMatch(/\\\\DeepLearning|physical/i);

    await expectApiError(
      await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'tree', 'pom.xml'),
      400,
      'INVALID_PATH',
    );
    await expectApiError(
      await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'meta', 'src'),
      400,
      'INVALID_PATH',
    );
  });

  it('returns 401 on file routes without a bearer token', async () => {
    const response = await fetch(fileResourceUrl(ALICE_SEED_PROJECT_ID, 'tree', ''), {
      headers: { Accept: 'application/json' },
    });
    expect(response.status).toBe(401);
    const body = await readJson<ApiErrorBody>(response);
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('counts file requests by method, project id and path', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '')).toBe(0);

    await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'tree', '');
    await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'tree', '');
    await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'tree', 'src');
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '')).toBe(2);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(1);

    await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'meta', 'assets/logo.png');
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'assets/logo.png')).toBe(1);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'assets/logo.png')).toBe(0);

    await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'content', 'assets/logo.png');
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'assets/logo.png')).toBe(1);
  });

  it('resetMockState clears file counters and large-file mode', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'tree', '');
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '')).toBe(1);

    setLargeFileBodiesEnabled(true);
    resetMockState();
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '')).toBe(0);

    const again = await loginOk(ALICE.username, ALICE.password);
    const response = await fetchFileResource(
      again.accessToken,
      ALICE_SEED_PROJECT_ID,
      'content',
      'docs/large-notes.md',
    );
    expect(response.status).toBe(200);
    const body = parseFileContentResponse(
      await response.json(),
      parseProjectRelativePath('docs/large-notes.md'),
    );
    expect(body.content.length).toBeLessThan(10_000);
  });

  it('returns the same generic 403 when Alice requests Bob file resources without leaking owner, project or path', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const cases: Array<{
      resource: 'tree' | 'meta' | 'content' | 'download';
      path: string;
    }> = [
      { resource: 'tree', path: 'samples' },
      { resource: 'meta', path: 'lab-notes.md' },
      { resource: 'content', path: 'lab-notes.md' },
      { resource: 'download', path: 'lab-notes.md' },
    ];
    for (const item of cases) {
      const body = await expectGenericForbidden(
        await fetchFileResource(alice.accessToken, BOB_SEED_PROJECT_ID, item.resource, item.path),
      );
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(item.path);
      expect(serialized).not.toContain(BOB_SEED_PROJECT_ID);
      expect(serialized).not.toContain('lab-notes');
      expect(serialized).not.toContain('samples');
      expect(serialized).not.toMatch(/C:\\|\/Users\/|\/etc\//);
    }
  });

  it('rejects blocked content even when Accept asks for bytes', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const blocked = [
      { path: 'assets/logo.png', status: 415, code: 'BINARY_FILE' as const },
      { path: 'docs/too-large.md', status: 413, code: 'FILE_TOO_LARGE' as const },
      { path: 'docs/latin1.txt', status: 400, code: 'VALIDATION_ERROR' as const },
    ];
    for (const item of blocked) {
      const response = await fetch(fileResourceUrl(ALICE_SEED_PROJECT_ID, 'content', item.path), {
        headers: {
          Accept: 'application/octet-stream',
          Authorization: `Bearer ${alice.accessToken}`,
        },
      });
      const body = await expectApiError(response, item.status, item.code);
      expect(body).not.toHaveProperty('content');
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/class App|PNG|latin-?1|ISO-8859/i);
      expect(serialized).not.toMatch(/C:\\|\/Users\/|\/etc\//);
    }
  });

  it('returns 401 on file download after the current token is expired', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const expire = await fetch('/api/v1/session/expire', {
      method: 'POST',
      headers: bearerHeaders(alice.accessToken),
    });
    expect(expire.status).toBe(204);

    const download = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'download',
      'pom.xml',
    );
    expect(download.status).toBe(401);
    const body = await readJson<ApiErrorBody>(download);
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(body)).not.toMatch(leakPattern());
    expect(JSON.stringify(body)).not.toContain('pom.xml');
  });

  it('never prints physical server paths in INVALID_PATH bodies', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const physical = ['C:\\Users\\alice\\secret', '/Users/alice/secret', '/etc/passwd'];
    for (const path of physical) {
      for (const resource of ['tree', 'meta', 'content', 'download'] as const) {
        const body = await expectApiError(
          await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, resource, path),
          400,
          'INVALID_PATH',
        );
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(path);
        expect(serialized).not.toMatch(/C:\\|\/Users\/|\/etc\/|\\\\DeepLearning/);
        expect(body.message).toBe('Invalid path');
      }
    }
  });
});

describe('MSW writable file handlers', () => {
  it('creates a root file and a nested file, then rejects a collision without advancing revision', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);

    const rootCreated = await postCreateEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'file',
      'notes.txt',
      SEED_REVISION,
    );
    expect(rootCreated.status).toBe(200);
    const rootBody = parseCreateEntryResponse(
      await rootCreated.json(),
      parseProjectRelativePath('notes.txt'),
      'file',
    );
    expect(rootBody.workspaceRevision).toBe('mock-rev-0002');
    expect(rootBody.entry).toMatchObject({
      path: 'notes.txt',
      name: 'notes.txt',
      kind: 'file',
      hidden: false,
      sizeBytes: 0,
      hasChildren: null,
    });
    expect(rootBody.file).toMatchObject({
      path: 'notes.txt',
      sizeBytes: 0,
      renderMode: 'MONACO_TEXT',
      blockReason: null,
      encoding: 'UTF-8',
    });

    const nestedCreated = await postCreateEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'file',
      'src/main/java/demo/Util.java',
      'mock-rev-0002',
    );
    expect(nestedCreated.status).toBe(200);
    const nestedBody = parseCreateEntryResponse(
      await nestedCreated.json(),
      parseProjectRelativePath('src/main/java/demo/Util.java'),
      'file',
    );
    expect(nestedBody.workspaceRevision).toBe('mock-rev-0003');

    const collision = await postCreateEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'file',
      'notes.txt',
      'mock-rev-0003',
    );
    await expectApiError(collision, 409, 'ENTRY_ALREADY_EXISTS');

    const tree = await readTree(alice.accessToken, ALICE_SEED_PROJECT_ID, '');
    expect(tree.workspaceRevision).toBe('mock-rev-0003');
    expect(tree.entries.map((entry) => entry.name)).toContain('notes.txt');
    const demo = await readTree(alice.accessToken, ALICE_SEED_PROJECT_ID, 'src/main/java/demo');
    expect(demo.workspaceRevision).toBe('mock-rev-0003');
    expect(demo.entries.map((entry) => entry.name).sort()).toEqual([
      'App.java',
      'NearLimit.java',
      'Util.java',
    ]);
  });

  it('creates an empty directory and lists it with hasChildren false', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const created = await postCreateEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'directory',
      'tmp',
      SEED_REVISION,
    );
    expect(created.status).toBe(200);
    const body = parseCreateEntryResponse(
      await created.json(),
      parseProjectRelativePath('tmp'),
      'directory',
    );
    expect(body.file).toBeNull();
    expect(body.workspaceRevision).toBe('mock-rev-0002');
    expect(body.entry).toMatchObject({
      path: 'tmp',
      kind: 'directory',
      sizeBytes: null,
      hasChildren: false,
    });

    const listed = await readTree(alice.accessToken, ALICE_SEED_PROJECT_ID, 'tmp');
    expect(listed.workspaceRevision).toBe('mock-rev-0002');
    expect(listed.entries).toEqual([]);
  });

  it('renames a file in the same directory and leaves the old path gone', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const renamed = await postRenameEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'README.md',
      'NOTES.md',
      SEED_REVISION,
    );
    expect(renamed.status).toBe(200);
    const body = parseRenameEntryResponse(
      await renamed.json(),
      parseProjectRelativePath('README.md'),
      parseProjectRelativePath('NOTES.md'),
    );
    expect(body.workspaceRevision).toBe('mock-rev-0002');
    expect(body.entry.path).toBe('NOTES.md');
    expect(body.file?.path).toBe('NOTES.md');

    const tree = await readTree(alice.accessToken, ALICE_SEED_PROJECT_ID, '');
    expect(tree.workspaceRevision).toBe('mock-rev-0002');
    expect(tree.entries.map((entry) => entry.name)).toContain('NOTES.md');
    expect(tree.entries.map((entry) => entry.name)).not.toContain('README.md');
    await expectApiError(
      await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'meta', 'README.md'),
      400,
      'INVALID_PATH',
    );
  });

  it('remaps directory descendants on rename without touching a same-prefix sibling', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const sibling = await postCreateEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'file',
      'src-notes.md',
      SEED_REVISION,
    );
    expect(sibling.status).toBe(200);

    const renamed = await postRenameEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'src',
      'source',
      'mock-rev-0002',
    );
    expect(renamed.status).toBe(200);
    const body = parseRenameEntryResponse(
      await renamed.json(),
      parseProjectRelativePath('src'),
      parseProjectRelativePath('source'),
    );
    expect(body.workspaceRevision).toBe('mock-rev-0003');
    expect(body.file).toBeNull();
    expect(body.entry).toMatchObject({
      path: 'source',
      kind: 'directory',
      hasChildren: true,
    });

    const demo = await readTree(alice.accessToken, ALICE_SEED_PROJECT_ID, 'source/main/java/demo');
    expect(demo.workspaceRevision).toBe('mock-rev-0003');
    expect(demo.entries.map((entry) => entry.name).sort()).toEqual(['App.java', 'NearLimit.java']);

    const app = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'content',
      'source/main/java/demo/App.java',
    );
    expect(app.status).toBe(200);
    const appBody = parseFileContentResponse(
      await app.json(),
      parseProjectRelativePath('source/main/java/demo/App.java'),
    );
    expect(appBody.content).toContain('class App');
    expect(appBody.workspaceRevision).toBe('mock-rev-0003');

    await expectApiError(
      await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'content', APP_JAVA_PATH),
      400,
      'INVALID_PATH',
    );

    const root = await readTree(alice.accessToken, ALICE_SEED_PROJECT_ID, '');
    expect(root.entries.map((entry) => entry.name)).toContain('src-notes.md');
    expect(root.entries.map((entry) => entry.name)).toContain('source');
    expect(root.entries.map((entry) => entry.name)).not.toContain('src');
  });

  it('deletes a file and an empty directory, and rejects a non-empty directory', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);

    const createdDir = await postCreateEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'directory',
      'tmp',
      SEED_REVISION,
    );
    expect(createdDir.status).toBe(200);

    const deletedFile = await deleteProjectEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'README.md',
      'mock-rev-0002',
    );
    expect(deletedFile.status).toBe(200);
    const fileBody = parseDeleteEntryResponse(
      await deletedFile.json(),
      parseProjectRelativePath('README.md'),
    );
    expect(fileBody).toEqual({ path: 'README.md', workspaceRevision: 'mock-rev-0003' });

    const deletedDir = await deleteProjectEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'tmp',
      'mock-rev-0003',
    );
    expect(deletedDir.status).toBe(200);
    const dirBody = parseDeleteEntryResponse(
      await deletedDir.json(),
      parseProjectRelativePath('tmp'),
    );
    expect(dirBody.workspaceRevision).toBe('mock-rev-0004');

    const rejected = await deleteProjectEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'docs',
      'mock-rev-0004',
    );
    await expectApiError(rejected, 409, 'DIRECTORY_NOT_EMPTY');

    const tree = await readTree(alice.accessToken, ALICE_SEED_PROJECT_ID, '');
    expect(tree.workspaceRevision).toBe('mock-rev-0004');
    expect(tree.entries.map((entry) => entry.name)).not.toContain('README.md');
    expect(tree.entries.map((entry) => entry.name)).not.toContain('tmp');
    expect(tree.entries.map((entry) => entry.name)).toContain('docs');
    const docs = await readTree(alice.accessToken, ALICE_SEED_PROJECT_ID, 'docs');
    expect(docs.entries.length).toBeGreaterThan(0);
  });

  it('advances mock-rev exactly once per successful mutation and not on any rejected branch', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const bob = await loginOk(BOB.username, BOB.password);

    const created = await postCreateEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'file',
      'scratch.txt',
      SEED_REVISION,
    );
    expect(parseCreateEntryResponse(
      await created.json(),
      parseProjectRelativePath('scratch.txt'),
      'file',
    ).workspaceRevision).toBe('mock-rev-0002');

    const saved = await putFileContent(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'scratch.txt',
      'hello',
      'mock-rev-0002',
    );
    expect(parseSaveFileResponse(
      await saved.json(),
      parseProjectRelativePath('scratch.txt'),
    ).workspaceRevision).toBe('mock-rev-0003');

    const renamed = await postRenameEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'scratch.txt',
      'scratch-2.txt',
      'mock-rev-0003',
    );
    expect(parseRenameEntryResponse(
      await renamed.json(),
      parseProjectRelativePath('scratch.txt'),
      parseProjectRelativePath('scratch-2.txt'),
    ).workspaceRevision).toBe('mock-rev-0004');

    const folder = await postCreateEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'directory',
      'empty-dir',
      'mock-rev-0004',
    );
    expect(parseCreateEntryResponse(
      await folder.json(),
      parseProjectRelativePath('empty-dir'),
      'directory',
    ).workspaceRevision).toBe('mock-rev-0005');

    const failures: Array<{ label: string; response: Response }> = [
      {
        label: 'collision',
        response: await postCreateEntry(
          alice.accessToken,
          ALICE_SEED_PROJECT_ID,
          'file',
          'pom.xml',
          'mock-rev-0005',
        ),
      },
      {
        label: 'non-empty delete',
        response: await deleteProjectEntry(
          alice.accessToken,
          ALICE_SEED_PROJECT_ID,
          'docs',
          'mock-rev-0005',
        ),
      },
      {
        label: 'owner',
        response: await putFileContent(
          bob.accessToken,
          ALICE_SEED_PROJECT_ID,
          'scratch-2.txt',
          'stolen',
          'mock-rev-0005',
        ),
      },
      {
        label: 'invalid path',
        response: await postCreateEntry(
          alice.accessToken,
          ALICE_SEED_PROJECT_ID,
          'file',
          '../secret',
          'mock-rev-0005',
        ),
      },
      {
        label: 'revision mismatch',
        response: await putFileContent(
          alice.accessToken,
          ALICE_SEED_PROJECT_ID,
          'scratch-2.txt',
          'stale',
          SEED_REVISION,
        ),
      },
    ];
    await expectApiError(failures[0].response, 409, 'ENTRY_ALREADY_EXISTS');
    await expectApiError(failures[1].response, 409, 'DIRECTORY_NOT_EMPTY');
    await expectGenericForbidden(failures[2].response);
    await expectApiError(failures[3].response, 400, 'INVALID_PATH');
    await expectApiError(failures[4].response, 409, 'WORKSPACE_REVISION_CONFLICT');

    const tree = await readTree(alice.accessToken, ALICE_SEED_PROJECT_ID, '');
    expect(tree.workspaceRevision).toBe('mock-rev-0005');
    const content = await fetchFileResource(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'content',
      'scratch-2.txt',
    );
    const savedContent = parseFileContentResponse(
      await content.json(),
      parseProjectRelativePath('scratch-2.txt'),
    );
    expect(savedContent.content).toBe('hello');
    expect(savedContent.workspaceRevision).toBe('mock-rev-0005');
  });

  it('returns the same generic 403 for another owner, unknown ids and non-READY writes without mutating', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const bob = await loginOk(BOB.username, BOB.password);

    const foreign = await expectGenericForbidden(
      await putFileContent(
        alice.accessToken,
        BOB_SEED_PROJECT_ID,
        'lab-notes.md',
        'nope',
        SEED_REVISION,
      ),
    );
    const unknown = await expectGenericForbidden(
      await postCreateEntry(
        alice.accessToken,
        'prj-does-not-exist',
        'file',
        'notes.txt',
        SEED_REVISION,
      ),
    );
    expect(foreign.message).toBe(unknown.message);
    expect(JSON.stringify(foreign)).not.toContain('lab-notes');
    expect(JSON.stringify(foreign)).not.toContain(BOB_SEED_PROJECT_ID);

    const bobTree = await readTree(bob.accessToken, BOB_SEED_PROJECT_ID, '');
    expect(bobTree.workspaceRevision).toBe(SEED_REVISION);
    expect(bobTree.entries.map((entry) => entry.name)).toEqual(['lab-notes.md', 'samples']);

    const created = await readJson<ProjectSummary>(
      await createProject(alice.accessToken, 'NotReadyWrites'),
    );
    expect(created.state).toBe('CREATING');
    await expectGenericForbidden(
      await postCreateEntry(alice.accessToken, created.id, 'file', 'a.txt', SEED_REVISION),
    );
    const first = await readJson<ProjectSummary>(await getProject(alice.accessToken, created.id));
    expect(first.state).toBe('CREATING');
    await expectGenericForbidden(
      await deleteProjectEntry(alice.accessToken, created.id, 'a.txt', SEED_REVISION),
    );
  });

  it('rejects malformed write paths before comparing revision and leaves the workspace unchanged', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const malformed = ['../secret', 'src\\App.java', 'foo/../bar', '', 'foo//bar'];
    for (const path of malformed) {
      const createBody = await expectApiError(
        await postCreateEntry(alice.accessToken, ALICE_SEED_PROJECT_ID, 'file', path, 'mock-rev-9999'),
        400,
        'INVALID_PATH',
      );
      if (path !== '') {
        expect(JSON.stringify(createBody)).not.toContain(path);
      }
      const saveBody = await expectApiError(
        await putFileContent(
          alice.accessToken,
          ALICE_SEED_PROJECT_ID,
          path,
          'x',
          'mock-rev-9999',
        ),
        400,
        'INVALID_PATH',
      );
      if (path !== '') {
        expect(JSON.stringify(saveBody)).not.toContain(path);
      }
    }

    const missingParent = await expectApiError(
      await postCreateEntry(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'file',
        'ghost/new.txt',
        'mock-rev-9999',
      ),
      400,
      'INVALID_PATH',
    );
    expect(JSON.stringify(missingParent)).not.toContain('ghost/new.txt');

    const crossDirectory = await expectApiError(
      await postRenameEntry(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        APP_JAVA_PATH,
        'docs/App.java',
        'mock-rev-9999',
      ),
      400,
      'VALIDATION_ERROR',
    );
    expect(JSON.stringify(crossDirectory)).not.toContain(APP_JAVA_PATH);

    await expectSeedWorkspaceUnchanged(alice.accessToken, ALICE_SEED_PROJECT_ID);
  });

  it('rejects a stale revision without mutating, including when the lock scenario is set', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    expect((await postWriteScenario(alice.accessToken, 'locked')).status).toBe(204);

    await expectApiError(
      await putFileContent(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'README.md',
        'stale',
        'mock-rev-0002',
      ),
      409,
      'WORKSPACE_REVISION_CONFLICT',
    );
    await expectSeedWorkspaceUnchanged(alice.accessToken, ALICE_SEED_PROJECT_ID);
  });

  it('returns PROJECT_LOCKED after a matching revision and does not increment', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    expect((await postWriteScenario(alice.accessToken, 'locked')).status).toBe(204);
    await expectApiError(
      await putFileContent(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'README.md',
        'locked',
        SEED_REVISION,
      ),
      409,
      'PROJECT_LOCKED',
    );
    await expectSeedWorkspaceUnchanged(alice.accessToken, ALICE_SEED_PROJECT_ID);
  });

  it('measures UTF-8 bytes with TextEncoder and returns fresh save metadata', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const response = await putFileContent(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'README.md',
      '€',
      SEED_REVISION,
    );
    expect(response.status).toBe(200);
    const body = parseSaveFileResponse(
      await response.json(),
      parseProjectRelativePath('README.md'),
    );
    expect(body.workspaceRevision).toBe('mock-rev-0002');
    expect(body.file.sizeBytes).toBe(new TextEncoder().encode('€').byteLength);
    expect(body.file.sizeBytes).not.toBe('€'.length);
    expect(body.file.renderMode).toBe('MONACO_TEXT');
    expect(body.file.blockReason).toBeNull();
  });

  it('saves Markdown at 20 MiB as MONACO_TEXT', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const content = 'a'.repeat(20 * MIB);
    const response = await putFileContent(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'README.md',
      content,
      SEED_REVISION,
    );
    expect(response.status).toBe(200);
    const body = parseSaveFileResponse(
      await response.json(),
      parseProjectRelativePath('README.md'),
    );
    expect(body.file.sizeBytes).toBe(20 * MIB);
    expect(body.file.renderMode).toBe('MONACO_TEXT');
    expect(body.file.blockReason).toBeNull();
    expect(body.workspaceRevision).toBe('mock-rev-0002');
  }, 30_000);

  it('saves Markdown at 20 MiB + 1 as PLAIN_TEXT', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const content = 'a'.repeat(20 * MIB + 1);
    const response = await putFileContent(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'README.md',
      content,
      SEED_REVISION,
    );
    expect(response.status).toBe(200);
    const body = parseSaveFileResponse(
      await response.json(),
      parseProjectRelativePath('README.md'),
    );
    expect(body.file.sizeBytes).toBe(20 * MIB + 1);
    expect(body.file.renderMode).toBe('PLAIN_TEXT');
    expect(body.file.blockReason).toBeNull();
  }, 30_000);

  it('saves Markdown at 50 MiB as PLAIN_TEXT', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const content = 'a'.repeat(50 * MIB);
    const response = await putFileContent(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'README.md',
      content,
      SEED_REVISION,
    );
    expect(response.status).toBe(200);
    const body = parseSaveFileResponse(
      await response.json(),
      parseProjectRelativePath('README.md'),
    );
    expect(body.file.sizeBytes).toBe(50 * MIB);
    expect(body.file.renderMode).toBe('PLAIN_TEXT');
    expect(body.file.blockReason).toBeNull();
  }, 60_000);

  it('rejects Markdown at 50 MiB + 1 without mutating', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const content = 'a'.repeat(50 * MIB + 1);
    await expectApiError(
      await putFileContent(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'README.md',
        content,
        SEED_REVISION,
      ),
      413,
      'FILE_TOO_LARGE',
    );
    await expectSeedWorkspaceUnchanged(alice.accessToken, ALICE_SEED_PROJECT_ID);
  }, 60_000);

  it('saves non-Markdown at 20 MiB as MONACO_TEXT', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const content = 'a'.repeat(20 * MIB);
    const response = await putFileContent(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      APP_JAVA_PATH,
      content,
      SEED_REVISION,
    );
    expect(response.status).toBe(200);
    const body = parseSaveFileResponse(
      await response.json(),
      parseProjectRelativePath(APP_JAVA_PATH),
    );
    expect(body.file.sizeBytes).toBe(20 * MIB);
    expect(body.file.renderMode).toBe('MONACO_TEXT');
    expect(body.file.blockReason).toBeNull();
  }, 30_000);

  it('rejects non-Markdown at 20 MiB + 1 without mutating', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const content = 'a'.repeat(20 * MIB + 1);
    await expectApiError(
      await putFileContent(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        APP_JAVA_PATH,
        content,
        SEED_REVISION,
      ),
      413,
      'FILE_TOO_LARGE',
    );
    const meta = parseFileMetadata(
      await (await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'meta', APP_JAVA_PATH)).json(),
      parseProjectRelativePath(APP_JAVA_PATH),
    );
    expect(meta.sizeBytes).toBeLessThan(10_000);
    const tree = await readTree(alice.accessToken, ALICE_SEED_PROJECT_ID, '');
    expect(tree.workspaceRevision).toBe(SEED_REVISION);
  }, 30_000);

  it('rejects blocked, binary and non-UTF-8 PUT even when called directly', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    await expectApiError(
      await putFileContent(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'assets/logo.png',
        'not-a-png',
        SEED_REVISION,
      ),
      415,
      'BINARY_FILE',
    );
    await expectApiError(
      await putFileContent(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'docs/latin1.txt',
        'cafe',
        SEED_REVISION,
      ),
      400,
      'VALIDATION_ERROR',
    );
    await expectApiError(
      await putFileContent(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'docs/too-large.md',
        'small',
        SEED_REVISION,
      ),
      413,
      'FILE_TOO_LARGE',
    );
    await expectSeedWorkspaceUnchanged(alice.accessToken, ALICE_SEED_PROJECT_ID);
  });

  it('chooses mock-only write scenarios without importing them from production modules', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);

    const missing = await fetch('/api/v1/session/write-scenario', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'locked' }),
    });
    expect(missing.status).toBe(401);

    expect((await postWriteScenario(alice.accessToken, 'conflict')).status).toBe(204);
    await expectApiError(
      await putFileContent(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'README.md',
        'conflict',
        SEED_REVISION,
      ),
      409,
      'WORKSPACE_REVISION_CONFLICT',
    );

    expect((await postWriteScenario(alice.accessToken, 'failure')).status).toBe(204);
    await expectApiError(
      await putFileContent(
        alice.accessToken,
        ALICE_SEED_PROJECT_ID,
        'README.md',
        'boom',
        SEED_REVISION,
      ),
      500,
      'INTERNAL_ERROR',
    );

    expect((await postWriteScenario(alice.accessToken, 'delayed')).status).toBe(204);
    const started = Date.now();
    const delayed = await putFileContent(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'README.md',
      'delayed',
      SEED_REVISION,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(WRITE_SCENARIO_DELAY_MS - 50);
    expect(delayed.status).toBe(200);
    expect(parseSaveFileResponse(
      await delayed.json(),
      parseProjectRelativePath('README.md'),
    ).workspaceRevision).toBe('mock-rev-0002');

    resetMockState();
    const afterDelay = await loginOk(ALICE.username, ALICE.password);
    expect((await postWriteScenario(afterDelay.accessToken, 'normal')).status).toBe(204);
    const saved = await putFileContent(
      afterDelay.accessToken,
      ALICE_SEED_PROJECT_ID,
      'README.md',
      'ok',
      SEED_REVISION,
    );
    expect(saved.status).toBe(200);
    expect(parseSaveFileResponse(
      await saved.json(),
      parseProjectRelativePath('README.md'),
    ).workspaceRevision).toBe('mock-rev-0002');
  });

  it('resetMockState restores files, directories, revision, write scenario and counters', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    expect((await postWriteScenario(alice.accessToken, 'locked')).status).toBe(204);
    const created = await postCreateEntry(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      'file',
      'ephemeral.txt',
      SEED_REVISION,
    );
    await expectApiError(created, 409, 'PROJECT_LOCKED');
    await fetchFileResource(alice.accessToken, ALICE_SEED_PROJECT_ID, 'tree', '');
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '')).toBe(1);

    resetMockState();
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '')).toBe(0);

    const again = await loginOk(ALICE.username, ALICE.password);
    await expectSeedWorkspaceUnchanged(again.accessToken, ALICE_SEED_PROJECT_ID);
    const saved = await putFileContent(
      again.accessToken,
      ALICE_SEED_PROJECT_ID,
      'README.md',
      'after-reset',
      SEED_REVISION,
    );
    expect(saved.status).toBe(200);
    expect(parseSaveFileResponse(
      await saved.json(),
      parseProjectRelativePath('README.md'),
    ).workspaceRevision).toBe('mock-rev-0002');
  });
});

describe('MSW run-scenario handlers', () => {
  async function postRunScenario(token: string, scenario: string): Promise<Response> {
    return fetch('/api/v1/session/run-scenario', {
      method: 'POST',
      headers: {
        ...bearerHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scenario }),
    });
  }

  it('requires authentication and returns 204 for Stage 4 scenarios', async () => {
    const missing = await fetch('/api/v1/session/run-scenario', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'timeout' }),
    });
    expect(missing.status).toBe(401);

    const alice = await loginOk(ALICE.username, ALICE.password);
    await expectApiError(await postRunScenario(alice.accessToken, 'normal'), 400, 'VALIDATION_ERROR');
    expect(getRunScenario()).toBe('success');

    for (const scenario of [
      'success',
      'failure',
      'timeout',
      'recovery',
      'delayed-start',
      'gap',
      'disconnect',
      'large-log',
      'reload-change',
    ]) {
      expect((await postRunScenario(alice.accessToken, scenario)).status).toBe(204);
      expect(getRunScenario()).toBe(scenario);
    }
  });

  it('resetMockState clears run scenario, active run and the mock persistence key', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    expect((await postRunScenario(alice.accessToken, 'failure')).status).toBe(204);
    installVirtualRunClock(Date.parse('2026-08-24T10:00:00.000Z'));
    const started = startRun(ALICE_SEED_PROJECT_ID, {
      expectedWorkspaceRevision: SEED_REVISION,
    });
    expect(started.ok).toBe(true);
    expect(getActiveRun(ALICE_SEED_PROJECT_ID)?.state).toBe('STARTING');
    expect(sessionStorage.getItem(MOCK_RUN_PERSISTENCE_KEY)).not.toBeNull();

    resetMockState();
    expect(getRunScenario()).toBe('success');
    expect(getActiveRun(ALICE_SEED_PROJECT_ID)).toBeNull();
    expect(sessionStorage.getItem(MOCK_RUN_PERSISTENCE_KEY)).toBeNull();
  });
});

describe('MSW terminal handlers', () => {
  function terminalSessionsUrl(projectId: string, runId: string): string {
    return `/api/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/terminal-sessions`;
  }

  async function postTerminalSession(
    token: string,
    projectId: string,
    runId: string,
    body: unknown = { cols: 80, rows: 24 },
  ): Promise<Response> {
    return fetch(terminalSessionsUrl(projectId, runId), {
      method: 'POST',
      headers: { ...bearerHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function startRunningRun(): string {
    const started = startRun(ALICE_SEED_PROJECT_ID, {
      expectedWorkspaceRevision: SEED_REVISION,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.code);
    const running = transitionRun(ALICE_SEED_PROJECT_ID, started.value.run.id, {
      state: 'RUNNING',
    });
    expect(running.ok).toBe(true);
    return started.value.run.id;
  }

  it('creates only an opaque thirty-second reservation for the current owner RUNNING run', async () => {
    const missing = await fetch(terminalSessionsUrl(ALICE_SEED_PROJECT_ID, 'run-1'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    await expectApiError(missing, 401, 'UNAUTHENTICATED');
    const alice = await loginOk(ALICE.username, ALICE.password);
    const runId = startRunningRun();
    const before = Date.now();

    const response = await postTerminalSession(alice.accessToken, ALICE_SEED_PROJECT_ID, runId);
    const after = Date.now();

    expect(response.status).toBe(201);
    const reservation = parseCreateTerminalSessionResponse(await response.json(), new Date(before));
    expect(reservation.sessionId).toMatch(/^mock-terminal-session-/);
    expect(reservation.ticket).toMatch(/^mock-terminal-ticket-/);
    expect(Date.parse(reservation.expiresAt)).toBeGreaterThanOrEqual(before + 30_000);
    expect(Date.parse(reservation.expiresAt)).toBeLessThanOrEqual(after + 30_000);
    expect(getLiveTerminalSession('usr-alice', ALICE_SEED_PROJECT_ID, runId)).toBeNull();
    await expectApiError(
      await postTerminalSession(alice.accessToken, ALICE_SEED_PROJECT_ID, runId, {
        cols: 80,
        rows: 24,
        command: 'whoami',
      }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('rejects non-owner, non-running, history and unknown authority without physical ids', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const bob = await loginOk(BOB.username, BOB.password);
    const started = startRun(ALICE_SEED_PROJECT_ID, {
      expectedWorkspaceRevision: SEED_REVISION,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.code);

    await expectApiError(
      await postTerminalSession(bob.accessToken, ALICE_SEED_PROJECT_ID, started.value.run.id),
      403,
      'FORBIDDEN',
    );
    await expectApiError(
      await postTerminalSession(alice.accessToken, ALICE_SEED_PROJECT_ID, started.value.run.id),
      409,
      'TERMINAL_NOT_AVAILABLE',
    );
    await expectApiError(
      await postTerminalSession(alice.accessToken, ALICE_SEED_PROJECT_ID, 'run-unknown'),
      409,
      'TERMINAL_NOT_AVAILABLE',
    );
    expect(transitionRun(ALICE_SEED_PROJECT_ID, started.value.run.id, { state: 'RUNNING' }).ok).toBe(true);
    expect(transitionRun(ALICE_SEED_PROJECT_ID, started.value.run.id, { state: 'SUCCEEDED' }).ok).toBe(true);
    startRunningRun();
    const history = await postTerminalSession(
      alice.accessToken,
      ALICE_SEED_PROJECT_ID,
      started.value.run.id,
    );
    const body = await expectApiError(history, 409, 'TERMINAL_NOT_AVAILABLE');
    expect(JSON.stringify(body)).not.toMatch(/pvc|pod|job|container|C:\\|D:\\|\/home\/|\/var\//i);
  });

  it('lists retained backend audits with owner isolation and cursor pagination', async () => {
    const alice = await loginOk(ALICE.username, ALICE.password);
    const bob = await loginOk(BOB.username, BOB.password);
    const runId = startRunningRun();
    seedTerminalAuditFixtures('usr-alice', ALICE_SEED_PROJECT_ID, runId);
    const base = `/api/v1/projects/${encodeURIComponent(ALICE_SEED_PROJECT_ID)}/runs/${encodeURIComponent(runId)}/terminal-audits`;

    const first = await fetch(`${base}?limit=2`, { headers: bearerHeaders(alice.accessToken) });
    expect(first.status).toBe(200);
    const firstPage = parseTerminalAuditListResponse(await first.json());
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const second = await fetch(
      `${base}?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      { headers: bearerHeaders(alice.accessToken) },
    );
    expect(parseTerminalAuditListResponse(await second.json()).items).toHaveLength(2);
    await expectApiError(
      await fetch(base, { headers: bearerHeaders(bob.accessToken) }),
      403,
      'FORBIDDEN',
    );
  });

  it('selects every authenticated Stage 5 scenario through the mock-only endpoint', async () => {
    const url = '/api/v1/session/terminal-scenario';
    const missing = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'stress' }),
    });
    await expectApiError(missing, 401, 'UNAUTHENTICATED');
    const alice = await loginOk(ALICE.username, ALICE.password);
    const post = (scenario: string) => fetch(url, {
      method: 'POST',
      headers: { ...bearerHeaders(alice.accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario }),
    });
    await expectApiError(await post('production'), 400, 'VALIDATION_ERROR');
    for (const scenario of [
      'normal',
      'ticket-expired',
      'already-active',
      'server-pause',
      'disconnect',
      'shell-exit',
      'webgl-fallback',
      'audit',
      'stress',
    ]) {
      expect((await post(scenario)).status).toBe(204);
      expect(getTerminalScenario()).toBe(scenario);
    }
  });
});
