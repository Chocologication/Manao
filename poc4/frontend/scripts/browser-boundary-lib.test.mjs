import assert from 'node:assert/strict';
import test from 'node:test';
import * as boundary from './browser-boundary-lib.mjs';
import {
  findForbiddenContractNames,
  findForbiddenDependencies,
  findForbiddenDistributionStrings,
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

const stage4ProductionModules = [
  'src/api/runApi.ts',
  'src/contracts/run.ts',
  'src/contracts/log.ts',
  'src/features/runs/runQueries.ts',
  'src/features/runs/runMutations.ts',
  'src/features/runs/RunAuthorityCoordinator.ts',
  'src/features/logs/RunLogStore.ts',
  'src/features/logs/RunLogTransport.ts',
  'src/components/runs/RunPanel.tsx',
  'src/components/runs/RunToolbar.tsx',
  'src/components/runs/RunHistory.tsx',
  'src/components/runs/RunLogView.tsx',
  'src/components/runs/StopRunDialog.tsx',
];

const stage4MockNeedles = [
  ['stage4-scenario-endpoint', '/api/v1/session/run-scenario'],
  ['stage4-mock-ticket-prefix', 'mock-run-log-ticket-'],
  ['stage4-seed-log-marker', 'ensoai-stage4-seed-log'],
  ['stage4-mock-persistence-key', 'ensoai.mock.run-scenario.v1'],
];

const stage5ProductionModules = [
  'src/api/terminalApi.ts',
  'src/contracts/terminal.ts',
  'src/features/terminal/JobTerminalController.ts',
  'src/components/terminal/JobTerminalPanel.tsx',
  'src/components/terminal/JobTerminalToolbar.tsx',
  'src/components/terminal/TerminalAuditView.tsx',
  'src/components/terminal/CloseTerminalDialog.tsx',
];

const stage5MockNeedles = [
  ['stage5-scenario-endpoint', '/api/v1/session/terminal-scenario'],
  ['stage5-mock-ticket-prefix', 'mock-terminal-ticket-'],
  ['stage5-mock-session-prefix', 'mock-terminal-session-'],
  ['stage5-mock-audit-prefix', 'mock-terminal-audit-'],
  ['stage5-stress-marker', 'ensoai-stage5-terminal-stress'],
  ['stage5-mock-persistence-key', 'ensoai.mock.terminal-scenario.v1'],
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

test('classifies Stage 4 run and log production modules', () => {
  const source = "import { mockFiles } from '@/spike/mockFiles';";
  for (const file of [...plannedWritableWorkbenchModules, ...stage4ProductionModules]) {
    assert.deepEqual(
      findForbiddenWorkbenchImports(file, source).map((item) => item.rule),
      ['stage0-spike-import'],
      file,
    );
  }
});

test('rejects terminal, mocks, echo-ws and Node built-ins from Stage 4 production modules', () => {
  assert.deepEqual(
    findForbiddenWorkbenchImports(
      'src/api/runApi.ts',
      "import { TerminalSession } from '@/terminal/TerminalSession';",
    ).map((item) => item.rule),
    ['stage0-terminal-import'],
  );
  assert.deepEqual(
    findForbiddenWorkbenchImports(
      'src/contracts/log.ts',
      "import { handlers } from '@/mocks/handlers';",
    ).map((item) => item.rule),
    ['stage0-mocks-import'],
  );
  assert.deepEqual(
    findForbiddenWorkbenchImports(
      'src/features/runs/runQueries.ts',
      "import { createEcho } from '../../../scripts/echo-ws.mjs';",
    ).map((item) => item.rule),
    ['echo-ws-import'],
  );
  assert.deepEqual(
    findForbiddenWorkbenchImports(
      'src/components/runs/RunPanel.tsx',
      "import { Stage0SpikeApp } from '@/spike/Stage0SpikeApp';",
    ).map((item) => item.rule),
    ['stage0-spike-import'],
  );
  assert.deepEqual(
    findForbiddenSource('src/api/runApi.ts', "import fs from 'node:fs';").map((item) => item.rule),
    ['node-builtin'],
  );
});

test('rejects Stage 4 mock needles in production modules and keeps Stage 3 needles', () => {
  const writeScenario = "await fetch('/api/v1/session/write-scenario', { method: 'POST' });";
  assert.deepEqual(
    findForbiddenWorkbenchImports('src/api/runApi.ts', writeScenario).map((item) => item.rule),
    ['stage3-scenario-endpoint'],
  );
  for (const [rule, needle] of stage4MockNeedles) {
    const source = `const marker = ${JSON.stringify(needle)};`;
    assert.deepEqual(
      findForbiddenWorkbenchImports('src/contracts/run.ts', source).map((item) => item.rule),
      [rule],
      rule,
    );
    assert.deepEqual(
      findForbiddenWorkbenchImports('src/features/logs/RunLogStore.ts', source).map((item) => item.rule),
      [rule],
      rule,
    );
    assert.deepEqual(findForbiddenWorkbenchImports('src/mocks/handlers.ts', source), [], rule);
    assert.deepEqual(findForbiddenWorkbenchImports('src/main.tsx', source), [], rule);
  }
});

test('rejects Kubernetes resource identifiers in Stage 4 run contracts and features', () => {
  const source = [
    'export type Resource = { pvcName: string; podName: string };',
    'export const jobName = "build";',
    'export function bind(serviceAccount: string) {}',
    'export const payload = { namespace: "default" };',
  ].join('\n');
  for (const file of ['src/contracts/run.ts', 'src/contracts/log.ts', 'src/api/runApi.ts', 'src/features/runs/runQueries.ts']) {
    assert.deepEqual(
      findForbiddenContractNames(file, source).map((item) => item.rule),
      [
        'contract-name:pvcName',
        'contract-name:podName',
        'contract-name:jobName',
        'contract-name:serviceAccount',
        'contract-name:namespace',
      ],
      file,
    );
  }
});

test('classifies only the new Stage 5 terminal production modules', () => {
  const source = "import { mockFiles } from '@/spike/mockFiles';";
  for (const file of stage5ProductionModules) {
    assert.deepEqual(
      findForbiddenWorkbenchImports(file, source).map((item) => item.rule),
      ['stage0-spike-import'],
      file,
    );
  }
  assert.deepEqual(
    findForbiddenWorkbenchImports('src/components/terminal/TerminalPanel.tsx', source),
    [],
  );
});

test('rejects Stage 5 mock strings and physical identifiers in terminal production modules', () => {
  for (const [rule, needle] of stage5MockNeedles) {
    const source = `const marker = ${JSON.stringify(needle)};`;
    assert.deepEqual(
      findForbiddenWorkbenchImports('src/api/terminalApi.ts', source).map((item) => item.rule),
      [rule],
      rule,
    );
    assert.deepEqual(findForbiddenWorkbenchImports('src/mocks/terminalState.ts', source), [], rule);
  }
  const source = 'export const payload = { namespace: "hidden" };';
  for (const file of stage5ProductionModules) {
    assert.deepEqual(
      findForbiddenContractNames(file, source).map((item) => item.rule),
      ['contract-name:namespace'],
      file,
    );
  }
});

test('rejects every retained mock needle from distribution HTML', () => {
  const source = [...stage4MockNeedles, ...stage5MockNeedles]
    .map(([, needle]) => needle)
    .join('\n');
  assert.deepEqual(
    findForbiddenDistributionStrings('dist/index.html', source).map((item) => item.rule),
    [...stage4MockNeedles, ...stage5MockNeedles].map(([rule]) => rule),
  );
});

test('rejects the xterm package CSS import from the global entry stylesheet only', () => {
  assert.deepEqual(
    boundary.findTerminalCssSourceViolations(
      'src/styles/globals.css',
      '@import "@xterm/xterm/css/xterm.css";',
    ),
    [{ file: 'src/styles/globals.css', rule: 'xterm-css-global-import' }],
  );
  assert.deepEqual(
    boundary.findTerminalCssSourceViolations(
      'src/components/terminal/JobTerminalPanel.tsx',
      "import '@xterm/xterm/css/xterm.css';",
    ),
    [],
  );
});

test('rejects xterm selectors from a stylesheet linked by dist index.html', () => {
  const indexHtml = [
    '<link crossorigin href="./assets/index.css?build=1#app" rel="stylesheet">',
    '<script type="module" src="/assets/index.js"></script>',
  ].join('\n');
  const assets = [
    { file: 'dist/assets/index.css', source: '.xterm { width: 100%; }' },
    { file: 'dist/assets/terminal.css', source: '.xterm-screen { height: 100%; }' },
  ];

  assert.deepEqual(boundary.findTerminalCssDistributionViolations(indexHtml, assets), [
    { file: 'dist/assets/index.css', rule: 'xterm-css-entry-asset' },
  ]);
});

test('resolves a base-prefixed entry href to its unique dist CSS asset', () => {
  const indexHtml = '<link rel="stylesheet" href="/app/assets/index.css">';
  const assets = [
    { file: 'dist/assets/index.css', source: '.xterm { width: 100%; }' },
    { file: 'dist/assets/terminal.css', source: '.xterm-screen { height: 100%; }' },
  ];

  assert.deepEqual(boundary.findTerminalCssDistributionViolations(indexHtml, assets), [
    { file: 'dist/assets/index.css', rule: 'xterm-css-entry-asset' },
  ]);
});

test('rejects internal entry href basename collisions without an assets anchor', () => {
  const assets = [
    { file: 'dist/assets/index.css', source: 'body { margin: 0; }' },
    { file: 'dist/assets/terminal.css', source: '.xterm-screen { height: 100%; }' },
  ];

  for (const href of ['/index.css', 'index.css', './index.css', '/fooassets/index.css']) {
    assert.deepEqual(boundary.findTerminalCssDistributionViolations(
      `<link rel="stylesheet" href="${href}">`,
      assets,
    ), [
      { file: 'dist/index.html', rule: `xterm-css-entry-asset-missing:${href}` },
    ]);
  }
});

test('rejects an internal entry stylesheet href with no dist asset target', () => {
  const indexHtml = '<link rel="stylesheet" href="/assets/missing.css">';
  const assets = [
    { file: 'dist/assets/index.css', source: 'body { margin: 0; }' },
    { file: 'dist/assets/terminal.css', source: '.xterm-screen { height: 100%; }' },
  ];

  assert.deepEqual(boundary.findTerminalCssDistributionViolations(indexHtml, assets), [
    {
      file: 'dist/index.html',
      rule: 'xterm-css-entry-asset-missing:/assets/missing.css',
    },
  ]);
});

test('rejects an internal entry stylesheet href with ambiguous dist asset targets', () => {
  const indexHtml = '<link rel="stylesheet" href="/app/assets/index.css">';
  const assets = [
    { file: 'dist/assets/index.css', source: 'body { margin: 0; }' },
    { file: 'dist/static/assets/index.css', source: 'body { color: black; }' },
    { file: 'dist/assets/terminal.css', source: '.xterm-screen { height: 100%; }' },
  ];

  assert.deepEqual(boundary.findTerminalCssDistributionViolations(indexHtml, assets), [
    {
      file: 'dist/index.html',
      rule: 'xterm-css-entry-asset-ambiguous:/app/assets/index.css',
    },
  ]);
});

test('rejects a production distribution with no non-entry xterm stylesheet', () => {
  const indexHtml = '<link rel="stylesheet" href="/assets/index.css">';
  const assets = [{ file: 'dist/assets/index.css', source: 'body { margin: 0; }' }];

  assert.deepEqual(boundary.findTerminalCssDistributionViolations(indexHtml, assets), [
    { file: 'dist/index.html', rule: 'xterm-css-lazy-asset-missing' },
  ]);
});

test('accepts split xterm CSS outside Vite entry stylesheets for relative and absolute paths', () => {
  const indexHtml = [
    '<link href="/assets/index.css" crossorigin rel="stylesheet">',
    '<link rel="modulepreload" href="./assets/vendor.js">',
  ].join('\n');
  const assets = [
    { file: 'dist/assets/index.css', source: 'body { margin: 0; }' },
    { file: 'dist/assets/JobTerminalPanel.css', source: '.xterm-screen{height:100%}' },
  ];

  assert.deepEqual(boundary.findTerminalCssDistributionViolations(indexHtml, assets), []);
});
