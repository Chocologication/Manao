import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../contracts/api';
import type { LoginResponse } from '../contracts/auth';
import type { ProjectListResponse, ProjectSummary } from '../contracts/project';

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
