import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findForbiddenContractNames,
  findForbiddenDependencies,
  findForbiddenSource,
  findForbiddenWorkbenchImports,
} from './browser-boundary-lib.mjs';

const plannedWritableWorkbenchModules = [
  'src/api/fileApi.ts',
  'src/contracts/file.ts',
  'src/features/files/entryNamePolicy.ts',
  'src/features/files/fileMutations.ts',
  'src/features/editor/workspaceSession.ts',
  'src/features/editor/WorkspaceBufferRegistry.ts',
  'src/features/editor/unsavedChangesGuard.ts',
  'src/features/editor/runPreconditions.ts',
  'src/features/projects/ReadonlyWorkbenchPage.tsx',
  'src/features/projects/WorkbenchPage.tsx',
  'src/components/shell/WorkbenchShell.tsx',
  'src/components/files/FileTreeNode.tsx',
  'src/components/files/FileTree.tsx',
  'src/components/files/EditorWorkspace.tsx',
  'src/components/files/WritableMonacoEditor.tsx',
  'src/components/files/PlainTextEditor.tsx',
  'src/components/files/PlainTextViewer.tsx',
  'src/components/files/FileMutationDialogs.tsx',
  'src/components/files/UnsavedChangesDialog.tsx',
  'src/components/files/editorSaveCommand.ts',
  'src/components/files/ReadonlyFileTree.tsx',
  'src/components/files/ReadonlyEditorWorkspace.tsx',
  'src/components/files/ReadonlyMonacoEditor.tsx',
  'src/lib/projectMonacoModels.ts',
];

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

test('rejects Stage 0 spike imports from workbench production modules', () => {
  const source = "import { mockFiles } from '@/spike/mockFiles';";
  assert.deepEqual(
    findForbiddenWorkbenchImports('src/api/fileApi.ts', source).map((item) => item.rule),
    ['stage0-spike-import'],
  );
});

test('rejects terminal, mocks and echo-ws imports from workbench production modules', () => {
  assert.deepEqual(
    findForbiddenWorkbenchImports(
      'src/features/files/fileQueries.ts',
      "import { TerminalSession } from '@/terminal/TerminalSession';",
    ).map((item) => item.rule),
    ['stage0-terminal-import'],
  );
  assert.deepEqual(
    findForbiddenWorkbenchImports(
      'src/components/shell/WorkbenchShell.tsx',
      "import { handlers } from '@/mocks/handlers';",
    ).map((item) => item.rule),
    ['stage0-mocks-import'],
  );
  assert.deepEqual(
    findForbiddenWorkbenchImports(
      'src/features/editor/workspaceSession.ts',
      "import { createEcho } from '../../../scripts/echo-ws.mjs';",
    ).map((item) => item.rule),
    ['echo-ws-import'],
  );
});

test('classifies current Readonly modules and planned writable workbench modules', () => {
  const source = "import { mockFiles } from '@/spike/mockFiles';";
  for (const file of plannedWritableWorkbenchModules) {
    assert.deepEqual(
      findForbiddenWorkbenchImports(file, source).map((item) => item.rule),
      ['stage0-spike-import'],
      file,
    );
  }
});

test('allows monaco-editor imports in workbench production modules', () => {
  const source = "import * as monaco from 'monaco-editor';";
  const file = 'src/components/files/ReadonlyMonacoEditor.tsx';
  assert.deepEqual(findForbiddenWorkbenchImports(file, source), []);
  assert.deepEqual(findForbiddenSource(file, source), []);
});

test('does not classify main.tsx mock worker import as a workbench violation', () => {
  const source = "const { startMockWorker } = await import('./mocks/browser');";
  assert.deepEqual(findForbiddenWorkbenchImports('src/main.tsx', source), []);
});

test('allows Stage 0 imports outside the workbench production module set', () => {
  const source = "import { mockFiles } from '@/spike/mockFiles';";
  assert.deepEqual(findForbiddenWorkbenchImports('src/components/files/MonacoPanel.tsx', source), []);
});

test('rejects the Stage 3 mock scenario endpoint in workbench production modules', () => {
  const source = "await fetch('/api/v1/session/write-scenario', { method: 'POST' });";
  assert.deepEqual(
    findForbiddenWorkbenchImports('src/api/fileApi.ts', source).map((item) => item.rule),
    ['stage3-scenario-endpoint'],
  );
  assert.deepEqual(
    findForbiddenWorkbenchImports(
      'src/features/projects/WorkbenchPage.tsx',
      source,
    ).map((item) => item.rule),
    ['stage3-scenario-endpoint'],
  );
});

test('allows the Stage 3 mock scenario endpoint outside workbench production modules', () => {
  const source = "await fetch('/api/v1/session/write-scenario', { method: 'POST' });";
  assert.deepEqual(findForbiddenWorkbenchImports('src/mocks/handlers.ts', source), []);
  assert.deepEqual(findForbiddenWorkbenchImports('src/main.tsx', source), []);
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
