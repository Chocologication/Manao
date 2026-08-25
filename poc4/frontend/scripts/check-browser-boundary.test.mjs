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

async function createFixture({
  globalSource = '',
  indexHtml = '<script>window.ticket = "/api/v1/session/terminal-scenario";</script>\n',
  entryCss = 'body { margin: 0; }\n',
  lazyCss = '.xterm-screen { height: 100%; }\n',
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ensoai-browser-boundary-'));
  await Promise.all([
    mkdir(path.join(root, 'scripts')),
    mkdir(path.join(root, 'src')),
    mkdir(path.join(root, 'dist', 'assets'), { recursive: true }),
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
    writeFile(path.join(root, 'src', 'globals.css'), globalSource, 'utf8'),
    writeFile(path.join(root, 'dist', 'index.html'), indexHtml, 'utf8'),
    writeFile(path.join(root, 'dist', 'assets', 'index.css'), entryCss, 'utf8'),
    ...(lazyCss === null ? [] : [
      writeFile(path.join(root, 'dist', 'assets', 'terminal.css'), lazyCss, 'utf8'),
    ]),
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

test('rejects global, entry and missing lazy xterm CSS boundaries through the script', async (t) => {
  const fixtureRoot = await createFixture({
    globalSource: '@import "@xterm/xterm/css/xterm.css";\n',
    indexHtml: '<link crossorigin href="/assets/index.css" rel="stylesheet">\n',
    entryCss: '.xterm { width: 100%; }\n',
    lazyCss: null,
  });
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/check-browser-boundary.mjs'], {
      cwd: fixtureRoot,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /src\/globals\.css: xterm-css-global-import/);
      assert.match(error.stderr, /dist\/assets\/index\.css: xterm-css-entry-asset/);
      assert.match(error.stderr, /dist\/index\.html: xterm-css-lazy-asset-missing/);
      return true;
    },
  );
});

test('accepts a valid split xterm CSS distribution through the script', async (t) => {
  const fixtureRoot = await createFixture({
    indexHtml: '<link href="./assets/index.css?build=1" rel="stylesheet" crossorigin>\n',
  });
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const result = await execFileAsync(process.execPath, ['scripts/check-browser-boundary.mjs'], {
    cwd: fixtureRoot,
  });
  assert.match(result.stdout, /Browser boundary check passed\./);
  assert.equal(result.stderr, '');
});

test('rejects xterm entry CSS reached through a base-prefixed href', async (t) => {
  const fixtureRoot = await createFixture({
    indexHtml: '<link rel="stylesheet" href="/app/assets/index.css">\n',
    entryCss: '.xterm { width: 100%; }\n',
  });
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/check-browser-boundary.mjs'], {
      cwd: fixtureRoot,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /dist\/assets\/index\.css: xterm-css-entry-asset/);
      return true;
    },
  );
});

test('rejects an internal stylesheet href whose dist target is missing', async (t) => {
  const fixtureRoot = await createFixture({
    indexHtml: '<link rel="stylesheet" href="/assets/missing.css">\n',
  });
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/check-browser-boundary.mjs'], {
      cwd: fixtureRoot,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        /dist\/index\.html: xterm-css-entry-asset-missing:\/assets\/missing\.css/,
      );
      return true;
    },
  );
});
