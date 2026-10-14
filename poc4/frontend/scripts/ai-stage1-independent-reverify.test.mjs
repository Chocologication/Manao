/**
 * Unit test for the --api export of scripts/ai-stage1-independent-reverify.mjs
 * (node --test; run via pnpm test:ai-stage1:scripts).
 *
 * No deployment is involved: a stub fetch serves a nested workspace tree
 * (pom.xml + src/main/java/com/example/app/DemoController.java + a nested
 * fixture test) and the test asserts that the SAME exportProjectTree function
 * the CLI uses lands every file under the staging directory WITH its parent
 * directories created — the fix for the fix-round-2 finding that a deep Java
 * tree crashed the export on the first nested file.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportProjectTree } from './ai-stage1-independent-reverify.mjs';

const BASE = 'http://stub.invalid';
const TOKEN = 'stub-token';
const PROJECT = 'stub-project';

function tree(entries) {
  return (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, `/api/v1/projects/${PROJECT}/files/tree`);
    const path = parsed.searchParams.get('path') ?? '';
    return Promise.resolve(new Response(JSON.stringify({
      directory: path,
      entries: entries[path] ?? [],
      workspaceRevision: '9',
    }), { status: 200 }));
  };
}

test('exportProjectTree creates nested parent directories and lands every file', async () => {
  const demoSource = 'package com.example.app;\npublic class DemoController {}\n';
  const fixtureSource = 'package com.example.app;\nimport org.junit.jupiter.api.Test;\n';
  const bodies = {
    'pom.xml': 'POM',
    'src/main/java/com/example/app/DemoController.java': demoSource,
    'src/main/java/com/example/app/DemoControllerAcceptanceTest.java': fixtureSource,
  };
  const fetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/api/v1/projects/${PROJECT}/files/tree`) {
      return tree({
        '': [{ name: 'pom.xml', kind: 'file' }, { name: 'src', kind: 'directory', path: 'src' }],
        'src': [{ name: 'main', kind: 'directory', path: 'src/main' }],
        'src/main': [{ name: 'java', kind: 'directory', path: 'src/main/java' }],
        'src/main/java': [{ name: 'com', kind: 'directory', path: 'src/main/java/com' }],
        'src/main/java/com': [{ name: 'example', kind: 'directory', path: 'src/main/java/com/example' }],
        'src/main/java/com/example': [{ name: 'app', kind: 'directory', path: 'src/main/java/com/example/app' }],
        'src/main/java/com/example/app': [
          { name: 'DemoController.java', kind: 'file', path: 'src/main/java/com/example/app/DemoController.java' },
          { name: 'DemoControllerAcceptanceTest.java', kind: 'file', path: 'src/main/java/com/example/app/DemoControllerAcceptanceTest.java' },
        ],
      })(url);
    }
    const path = parsed.searchParams.get('path');
    if (parsed.pathname === `/api/v1/projects/${PROJECT}/files/content` && path in bodies) {
      return Promise.resolve(new Response(JSON.stringify({
        path, content: bodies[path], workspaceRevision: '9',
      }), { status: 200 }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };

  const staging = mkdtempSync(join(tmpdir(), 'ai-stage1-exporttest-'));
  try {
    await exportProjectTree({ baseUrl: BASE, token: TOKEN, projectId: PROJECT, stagingDir: staging, fetchImpl });

    const pom = readFileSync(join(staging, 'pom.xml'), 'utf8');
    const demo = readFileSync(join(staging, 'src', 'main', 'java', 'com', 'example', 'app', 'DemoController.java'), 'utf8');
    const fixture = readFileSync(join(staging, 'src', 'main', 'java', 'com', 'example', 'app', 'DemoControllerAcceptanceTest.java'), 'utf8');
    assert.equal(pom, 'POM');
    assert.equal(demo, demoSource);
    assert.equal(fixture, fixtureSource);
    assert.equal(existsSync(join(staging, 'src', 'main', 'java', 'com', 'example', 'app')), true);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('exportProjectTree serves the file route before the tree route and errors on HTTP failures', async () => {
  // A missing directory response must surface as an error, not an empty export.
  const staging = mkdtempSync(join(tmpdir(), 'ai-stage1-exporttest-'));
  try {
    await assert.rejects(
      exportProjectTree({
        baseUrl: BASE, token: TOKEN, projectId: PROJECT, stagingDir: staging,
        fetchImpl: () => Promise.resolve(new Response('boom', { status: 500 })),
      }),
      /HTTP 500|Unexpected token|boom|JSON/i,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('exportProjectTree fails closed on a legal JSON error tree response', async () => {
  // The exact gap of review finding I10: a 401/403/500 carrying VALID JSON
  // (`{"error": ...}`) used to parse and read as an EMPTY directory (`tree.entries
  // ?? []`), so the re-verification continued on an incomplete export. Any
  // non-OK tree answer must reject, whatever its body looks like.
  const staging = mkdtempSync(join(tmpdir(), 'ai-stage1-exporttest-'));
  try {
    await assert.rejects(
      exportProjectTree({
        baseUrl: BASE, token: TOKEN, projectId: PROJECT, stagingDir: staging,
        fetchImpl: () => Promise.resolve(
          new Response(JSON.stringify({ timestamp: '...', error: 'Forbidden', status: 403 }), { status: 403 }),
        ),
      }),
      /HTTP 403/,
    );
    // Nothing may be staged from an error response.
    assert.equal(existsSync(join(staging, 'pom.xml')), false);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('exportProjectTree fails closed on a legal JSON error content response', async () => {
  // Same rule for the per-file download: a valid-JSON 500 must reject, never
  // stage a fabricated or partial file.
  const staging = mkdtempSync(join(tmpdir(), 'ai-stage1-exporttest-'));
  try {
    await assert.rejects(
      exportProjectTree({
        baseUrl: BASE, token: TOKEN, projectId: PROJECT, stagingDir: staging,
        fetchImpl: (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === `/api/v1/projects/${PROJECT}/files/tree`) {
            return Promise.resolve(new Response(JSON.stringify({
              directory: '', entries: [{ name: 'pom.xml', kind: 'file', path: 'pom.xml' }],
            }), { status: 200 }));
          }
          return Promise.resolve(new Response(
            JSON.stringify({ timestamp: '...', error: 'Internal Server Error', status: 500 }),
            { status: 500 },
          ));
        },
      }),
      /HTTP 500/,
    );
    assert.equal(existsSync(join(staging, 'pom.xml')), false);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('exportProjectTree fails closed on a malformed tree payload', async () => {
  // A 200 whose body is not a tree (no entries array) must reject too — the
  // structure check, not only the status check, guards the verdict's inputs.
  const staging = mkdtempSync(join(tmpdir(), 'ai-stage1-exporttest-'));
  try {
    await assert.rejects(
      exportProjectTree({
        baseUrl: BASE, token: TOKEN, projectId: PROJECT, stagingDir: staging,
        fetchImpl: () => Promise.resolve(
          new Response(JSON.stringify({ detail: 'not a tree' }), { status: 200 }),
        ),
      }),
      /malformed tree/i,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});
