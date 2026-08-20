import assert from 'node:assert/strict';
import test from 'node:test';
import { findForbiddenDependencies, findForbiddenSource } from './browser-boundary-lib.mjs';

test('rejects Electron and PTY production dependencies', () => {
  assert.deepEqual(
    findForbiddenDependencies({ dependencies: { electron: '1', 'node-pty': '1' } }),
    ['electron', 'node-pty']
  );
});

test('rejects Electron APIs and machine-specific absolute paths', () => {
  const source = [
    'window.electronAPI.file.read(path)',
    "import { ipcRenderer } from 'electron'",
    "const root = 'D:\\\\DeepLearning\\\\repo'",
    "const macRoot = '/Users/example/repo'",
  ].join('\n');

  assert.deepEqual(findForbiddenSource('fixture.ts', source).map((item) => item.rule), [
    'electron-api',
    'electron-import',
    'windows-absolute-path',
    'macos-absolute-path',
  ]);
});

test('allows browser WebSocket and project-relative paths', () => {
  const source = "new WebSocket(url); const path = 'src/main/App.java';";
  assert.deepEqual(findForbiddenSource('fixture.ts', source), []);
});
