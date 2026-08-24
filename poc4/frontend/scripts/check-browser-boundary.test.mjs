import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ensoai-browser-boundary-'));
  await Promise.all([
    mkdir(path.join(root, 'scripts')),
    mkdir(path.join(root, 'src')),
    mkdir(path.join(root, 'dist')),
  ]);
  await Promise.all([
    copyFile(
      path.join(scriptsDirectory, 'browser-boundary-lib.mjs'),
      path.join(root, 'scripts', 'browser-boundary-lib.mjs'),
    ),
    copyFile(
      path.join(scriptsDirectory, 'check-browser-boundary.mjs'),
      path.join(root, 'scripts', 'check-browser-boundary.mjs'),
    ),
    writeFile(path.join(root, 'package.json'), '{"dependencies":{}}\n', 'utf8'),
    writeFile(
      path.join(root, 'dist', 'index.html'),
      '<script>window.ticket = "/api/v1/session/terminal-scenario";</script>\n',
      'utf8',
    ),
  ]);
  return root;
}

test('rejects forbidden mock strings discovered in dist index.html', async (t) => {
  const fixtureRoot = await createFixture();
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/check-browser-boundary.mjs'], {
      cwd: fixtureRoot,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /dist\/index\.html: stage5-scenario-endpoint/);
      return true;
    },
  );
});
