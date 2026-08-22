import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findForbiddenContractNames,
  findForbiddenDependencies,
  findForbiddenSource,
  findForbiddenStage2Imports,
} from './browser-boundary-lib.mjs';

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

test('rejects Node built-in imports', () => {
  const source = "import fs from 'node:fs';\nimport path from 'path';";
  assert.deepEqual(findForbiddenSource('src/api/fileApi.ts', source).map((item) => item.rule), [
    'node-builtin',
  ]);
});

test('rejects Stage 0 spike imports from Stage 2 production modules', () => {
  const source = "import { mockFiles } from '@/spike/mockFiles';";
  assert.deepEqual(
    findForbiddenStage2Imports('src/api/fileApi.ts', source).map((item) => item.rule),
    ['stage0-spike-import'],
  );
});

test('rejects terminal, mocks and echo-ws imports from Stage 2 production modules', () => {
  assert.deepEqual(
    findForbiddenStage2Imports(
      'src/features/files/fileQueries.ts',
      "import { TerminalSession } from '@/terminal/TerminalSession';",
    ).map((item) => item.rule),
    ['stage0-terminal-import'],
  );
  assert.deepEqual(
    findForbiddenStage2Imports(
      'src/components/shell/WorkbenchShell.tsx',
      "import { handlers } from '@/mocks/handlers';",
    ).map((item) => item.rule),
    ['stage0-mocks-import'],
  );
  assert.deepEqual(
    findForbiddenStage2Imports(
      'src/features/editor/workspaceSession.ts',
      "import { createEcho } from '../../../scripts/echo-ws.mjs';",
    ).map((item) => item.rule),
    ['echo-ws-import'],
  );
});

test('allows monaco-editor imports in Stage 2 production modules', () => {
  const source = "import * as monaco from 'monaco-editor';";
  const file = 'src/components/files/ReadonlyMonacoEditor.tsx';
  assert.deepEqual(findForbiddenStage2Imports(file, source), []);
  assert.deepEqual(findForbiddenSource(file, source), []);
});

test('does not classify main.tsx mock worker import as a Stage 2 violation', () => {
  const source = "const { startMockWorker } = await import('./mocks/browser');";
  assert.deepEqual(findForbiddenStage2Imports('src/main.tsx', source), []);
});

test('allows Stage 0 imports outside the Stage 2 production module set', () => {
  const source = "import { mockFiles } from '@/spike/mockFiles';";
  assert.deepEqual(findForbiddenStage2Imports('src/components/files/MonacoPanel.tsx', source), []);
});

test('rejects forbidden Kubernetes resource identifiers in production contracts', () => {
  const source = [
    'export type Resource = { pvcName: string; podName: string };',
    'export const jobName = "build";',
    'export function bind(serviceAccount: string) {}',
    'export const payload = { namespace: "default" };',
  ].join('\n');
  assert.deepEqual(
    findForbiddenContractNames('src/contracts/file.ts', source).map((item) => item.rule),
    [
      'contract-name:pvcName',
      'contract-name:podName',
      'contract-name:jobName',
      'contract-name:serviceAccount',
      'contract-name:namespace',
    ],
  );
});

test('rejects serialized property names in file feature code', () => {
  const source = 'const body = { "pvcName": id, \'podName\': name };';
  assert.deepEqual(
    findForbiddenContractNames('src/features/files/fileQueries.ts', source).map((item) => item.rule),
    ['contract-name:pvcName', 'contract-name:podName'],
  );
});

test('ignores forbidden words in comments and string values', () => {
  const source = [
    '// namespace is a cluster concern, not a UI field',
    '/* pvcName and podName stay on the server */',
    'export const hint = "do not send serviceAccount";',
  ].join('\n');
  assert.deepEqual(findForbiddenContractNames('src/contracts/file.ts', source), []);
});

test('does not scan unrelated modules for contract-name identifiers', () => {
  const source = 'export const namespace = "local";';
  assert.deepEqual(findForbiddenContractNames('src/lib/utils.ts', source), []);
});
