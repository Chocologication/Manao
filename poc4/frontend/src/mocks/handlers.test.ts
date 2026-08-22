import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../contracts/api';
import type { LoginResponse } from '../contracts/auth';
import {
  parseFileContentResponse,
  parseFileMetadata,
  parseFileTreeResponse,
} from '../contracts/file';
import type { ProjectListResponse, ProjectSummary } from '../contracts/project';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../features/files/pathPolicy';
import { getFileRequestCount, resetMockState, setLargeFileBodiesEnabled } from './state';

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
  return /bob|not found|does not exist|prj-bob|exist|usr-bob|pvc|pod|job|\\\\DeepLearning|C:\\\\|D:\\\\|\/home\/|\/var\/|physical/i;
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
  expect(JSON.stringify(body)).not.toMatch(/\\\\DeepLearning|C:\\\\Windows|\/etc\/passwd|physical/i);
  return body;
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
});
