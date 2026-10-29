#!/usr/bin/env node
/**
 * AI stage one acceptance bootstrap (pi-stage1 plan Task 6, bootstrap step).
 *
 * Prepares the UNIQUE dedicated acceptance project against a running acceptance
 * backend, so the browser acceptance (tests/e2e/ai-stage1.spec.ts) can accept it
 * through MANAO_AI_ACCEPTANCE_PROJECT_ID:
 *
 *   1. log in with the acceptance account (MANAO_AI_ACCEPTANCE_USERNAME/_PASSWORD
 *      at MANAO_AI_ACCEPTANCE_BASE_URL);
 *   2. create one uniquely named project from the Java Spring Boot web template
 *      (no MySQL/Redis - stage one builds need no database credentials), using a
 *      random creation key so a lost response replays to the SAME project;
 *   3. wait for READY;
 *   4. seed the locateable compile error into DemoController (Instant.nwo()) and
 *      seed the verbatim acceptance fixture at
 *      src/test/java/com/example/app/DemoControllerAcceptanceTest.java;
 *   5. round-trip both files and print the JSON summary the operator records
 *      (projectId, initial revision, fixture sha256).
 *
 * The script only pre-seeds inputs. It never writes Pi repair code, never touches
 * the user's pom, and never uploads the acceptance pom (that file belongs to the
 * independent re-verification build, controlled by the acceptance operator - see
 * poc4/deploy/ai-stage1/README.md). Running it twice creates a SECOND unique
 * project on purpose; every run's id is independent.
 *
 * Usage: node scripts/ai-stage1-bootstrap.mjs
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE_URL = (process.env.MANAO_AI_ACCEPTANCE_BASE_URL ?? '').replace(/\/+$/, '');
const USERNAME = process.env.MANAO_AI_ACCEPTANCE_USERNAME;
const PASSWORD = process.env.MANAO_AI_ACCEPTANCE_PASSWORD;

if (!BASE_URL || !USERNAME || !PASSWORD) {
  console.error(
    'bootstrap requires MANAO_AI_ACCEPTANCE_BASE_URL, MANAO_AI_ACCEPTANCE_USERNAME and '
      + 'MANAO_AI_ACCEPTANCE_PASSWORD: the acceptance backend must already be running and '
      + 'reachable. Nothing is created without them.',
  );
  process.exit(1);
}

const DEMO_FILE = 'src/main/java/com/example/app/DemoController.java';
const FIXTURE_FILE = 'src/test/java/com/example/app/DemoControllerAcceptanceTest.java';
const FIXTURE_BYTES = readFileSync(
  fileURLToPath(new URL('../tests/fixtures/ai-stage1/DemoControllerAcceptanceTest.java', import.meta.url)),
);
const FIXTURE_SHA256 = createHash('sha256').update(FIXTURE_BYTES).digest('hex');
const FIXTURE_CONTENT = FIXTURE_BYTES.toString('utf8');

// The template DemoController with the plan's locateable compile error: Pi must
// repair Instant.nwo() AND change the message to the target value.
const BROKEN_DEMO_CONTENT = `package com.example.app;

import java.time.Instant;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DemoController {

    public record Demo(String message, Instant timestamp) {}

    @GetMapping("/api/demo")
    public Demo demo() {
        return new Demo("Hello from Manao", Instant.nwo());
    }
}
`;

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function apiError(action, response, body) {
  const code = body && typeof body === 'object' && typeof body.code === 'string' ? body.code : '';
  return new Error(`${action} failed: HTTP ${response.status}${code ? ` (${code})` : ''}`);
}

async function api(action, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw apiError(action, response, parsed);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const summary = {
  baseUrl: BASE_URL,
  projectName: `ai-stage1-${timestamp()}-${randomUUID().slice(0, 4)}`,
  projectId: '',
  creationKey: randomUUID(),
  templateId: 'java-spring-boot-web',
  initialRevision: '',
  fixturePath: FIXTURE_FILE,
  fixtureSha256: FIXTURE_SHA256,
  demoPath: DEMO_FILE,
  createdAt: new Date().toISOString(),
};

const login = await api('login', '/api/v1/auth/login', {
  method: 'POST',
  body: { username: USERNAME, password: PASSWORD },
});
if (typeof login.accessToken !== 'string' || login.accessToken === '') {
  throw new Error('login did not issue an access token');
}
const token = login.accessToken;
console.log(`[bootstrap] logged in at ${BASE_URL}`);

const created = await api('create project', '/api/v1/projects', {
  method: 'POST',
  token,
  body: { name: summary.projectName, creationKey: summary.creationKey, templateId: summary.templateId },
});
if (typeof created.id !== 'string' || created.id === '') {
  throw new Error('the create response did not carry a project id');
}
summary.projectId = created.id;
console.log(`[bootstrap] project "${summary.projectName}" id=${summary.projectId} created; waiting for READY`);

// READY is the precondition every write (and the task start) requires; a cold
// workspace provisioning can take minutes, so this is bounded generously.
const READY_TIMEOUT_MS = 900_000;
const readyDeadline = Date.now() + READY_TIMEOUT_MS;
for (;;) {
  const view = await api('read project', `/api/v1/projects/${summary.projectId}`, { token });
  if (view.state === 'READY') {
    break;
  }
  if (Date.now() > readyDeadline) {
    throw new Error(
      `project ${summary.projectId} did not reach READY within ${READY_TIMEOUT_MS}ms `
        + `(state=${view.state}); abandon this round and bootstrap a fresh project`,
    );
  }
  await sleep(10_000);
}
console.log('[bootstrap] project READY');

async function currentRevision() {
  const tree = await api('read tree', `/api/v1/projects/${summary.projectId}/files/tree`, { token });
  if (typeof tree.workspaceRevision !== 'string' || tree.workspaceRevision === '') {
    throw new Error('the workspace tree did not carry a workspace revision');
  }
  return tree.workspaceRevision;
}

// Repair the template controller into the broken starting point.
await api('save broken DemoController',
  `/api/v1/projects/${summary.projectId}/files/content?path=${encodeURIComponent(DEMO_FILE)}`, {
  method: 'PUT',
  token,
  body: { content: BROKEN_DEMO_CONTENT, expectedWorkspaceRevision: await currentRevision() },
});

// The fixture lives in a directory the template does not carry. The agent
// requires each entry's immediate parent to exist, so the directory chain is
// created level by level, tolerating levels the template already carries.
const fixtureDir = FIXTURE_FILE.slice(0, FIXTURE_FILE.lastIndexOf('/'));
const levels = fixtureDir.split('/');
for (let depth = 1; depth <= levels.length; depth++) {
  const prefix = levels.slice(0, depth).join('/');
  try {
    await api(`create fixture parent directory ${prefix}`, `/api/v1/projects/${summary.projectId}/entries`, {
      method: 'POST',
      token,
      body: { kind: 'directory', path: prefix, expectedWorkspaceRevision: await currentRevision() },
    });
  } catch (error) {
    if (!/ENTRY_ALREADY_EXISTS/.test(String(error.message))) {
      throw error;
    }
  }
}
await api('create fixture entry', `/api/v1/projects/${summary.projectId}/entries`, {
  method: 'POST',
  token,
  body: { kind: 'file', path: FIXTURE_FILE, expectedWorkspaceRevision: await currentRevision() },
});
await api('save fixture content',
  `/api/v1/projects/${summary.projectId}/files/content?path=${encodeURIComponent(FIXTURE_FILE)}`, {
  method: 'PUT',
  token,
  body: { content: FIXTURE_CONTENT, expectedWorkspaceRevision: await currentRevision() },
});

// Round-trip both files: what the model will see is exactly what was seeded.
const savedDemo = await api('read back DemoController',
  `/api/v1/projects/${summary.projectId}/files/content?path=${encodeURIComponent(DEMO_FILE)}`, { token });
const savedFixture = await api('read back fixture',
  `/api/v1/projects/${summary.projectId}/files/content?path=${encodeURIComponent(FIXTURE_FILE)}`, { token });
if (!savedDemo.content.includes('Instant.nwo()')) {
  throw new Error('the seeded compile error did not round-trip');
}
if (savedFixture.content !== FIXTURE_CONTENT) {
  throw new Error('the fixture did not round-trip byte-for-byte');
}
summary.initialRevision = await currentRevision();
summary.seededAt = new Date().toISOString();

console.log(JSON.stringify(summary, null, 2));
console.log(
  '[bootstrap] NEXT STEPS (see poc4/deploy/ai-stage1/README.md):\n'
    + `  1. (re)start the acceptance backend with MANAO_AI_ENABLED=true and MANAO_AI_PROJECT_ID=${summary.projectId}\n`
    + '  2. start the Pi worker with a REAL provider configuration (no key: starts must be refused, never mocked)\n'
    + `  3. run the acceptance: MANAO_AI_ACCEPTANCE_PROJECT_ID=${summary.projectId} pnpm test:e2e:ai-stage1\n`
    + '  4. after the round, delete THIS project through the UI/API and check leftovers independently',
);
