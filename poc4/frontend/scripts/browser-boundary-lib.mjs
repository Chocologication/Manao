import { builtinModules } from 'node:module';
import path from 'node:path';

const forbiddenDependencies = ['electron', 'electron-vite', 'electron-log', 'node-pty'];

const sourceRules = [
  ['electron-api', /window\.electronAPI/],
  ['electron-import', /(?:from\s+|import\s*)['"]electron(?:\/[^'"]*)?['"]/],
  ['node-pty', /['"]node-pty['"]/],
  ['windows-absolute-path', /[A-Za-z]:\\+(?:Users|DeepLearning|Projects)\\/],
  ['macos-absolute-path', /['"]\/Users\//],
];

const nodeBuiltinRoots = new Set(
  builtinModules.map((name) => (name.startsWith('node:') ? name.slice(5) : name)),
);

const importSpecifierPattern = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function toPosix(file) {
  return file.replaceAll('\\', '/');
}

function stripSpecifierQuery(specifier) {
  return specifier.split('?')[0];
}

function extractImportSpecifiers(source) {
  importSpecifierPattern.lastIndex = 0;
  return [...source.matchAll(importSpecifierPattern)].map((match) => match[1]);
}

function isNodeBuiltinSpecifier(specifier) {
  const bare = stripSpecifierQuery(specifier);
  if (bare.startsWith('node:')) return true;
  const root = bare.split('/')[0];
  return nodeBuiltinRoots.has(root);
}

const workbenchProductionExact = new Set([
  'src/api/fileApi.ts',
  'src/api/runApi.ts',
  'src/api/terminalApi.ts',
  'src/contracts/file.ts',
  'src/contracts/run.ts',
  'src/contracts/log.ts',
  'src/contracts/terminal.ts',
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
  'src/components/files/FileMutationDialogs.tsx',
  'src/components/files/UnsavedChangesDialog.tsx',
  'src/components/files/editorSaveCommand.ts',
  'src/lib/projectMonacoModels.ts',
]);

function isWorkbenchProductionModule(file) {
  const normalized = toPosix(file);
  if (workbenchProductionExact.has(normalized)) return true;
  if (normalized.startsWith('src/features/files/')) return true;
  if (normalized.startsWith('src/features/runs/')) return true;
  if (normalized.startsWith('src/features/logs/')) return true;
  if (normalized.startsWith('src/features/terminal/')) return true;
  if (normalized.startsWith('src/components/runs/')) return true;
  if (normalized.startsWith('src/components/terminal/')) {
    const baseName = normalized.slice('src/components/terminal/'.length);
    return baseName.startsWith('JobTerminal') || baseName === 'TerminalAuditView.tsx' || baseName === 'CloseTerminalDialog.tsx';
  }
  const filesPrefix = 'src/components/files/';
  if (!normalized.startsWith(filesPrefix)) return false;
  const baseName = normalized.slice(filesPrefix.length);
  return !baseName.includes('/') && (baseName.startsWith('Readonly') || baseName === 'PlainTextViewer.tsx');
}

function resolveSpecifier(file, specifier) {
  const normalizedSpecifier = stripSpecifierQuery(toPosix(specifier));
  if (normalizedSpecifier.startsWith('@/')) {
    return `src/${normalizedSpecifier.slice(2)}`;
  }
  if (normalizedSpecifier.startsWith('.')) {
    const fromDir = path.posix.dirname(toPosix(file));
    return path.posix.normalize(`${fromDir}/${normalizedSpecifier}`);
  }
  return normalizedSpecifier;
}

function workbenchImportRule(file, specifier) {
  const resolved = resolveSpecifier(file, specifier);
  if (resolved === 'src/spike' || resolved.startsWith('src/spike/')) return 'stage0-spike-import';
  if (resolved === 'src/terminal' || resolved.startsWith('src/terminal/')) {
    return 'stage0-terminal-import';
  }
  if (resolved === 'src/mocks' || resolved.startsWith('src/mocks/')) return 'stage0-mocks-import';
  if (specifier.includes('scripts/echo-ws.mjs') || resolved === 'scripts/echo-ws.mjs' || resolved.endsWith('/scripts/echo-ws.mjs')) {
    return 'echo-ws-import';
  }
  return null;
}

function toRuleResults(file, rules) {
  return [...rules].map((rule) => ({ file, rule }));
}

export function findForbiddenDependencies(packageJson) {
  const production = Object.keys(packageJson.dependencies ?? {});
  return forbiddenDependencies.filter((name) => production.includes(name));
}

export function findForbiddenSource(file, source) {
  const rules = new Set();
  for (const [rule, pattern] of sourceRules) {
    if (pattern.test(source)) rules.add(rule);
  }
  for (const specifier of extractImportSpecifiers(source)) {
    if (isNodeBuiltinSpecifier(specifier)) rules.add('node-builtin');
  }
  return toRuleResults(file, rules);
}

export function findTerminalCssSourceViolations(file, source) {
  const normalized = toPosix(file);
  const isGlobalEntryStylesheet =
    normalized === 'src/styles/globals.css' || normalized === 'src/globals.css';
  if (!isGlobalEntryStylesheet) return [];
  const importsXtermCss = extractImportSpecifiers(source)
    .some((specifier) => stripSpecifierQuery(specifier) === '@xterm/xterm/css/xterm.css');
  return importsXtermCss
    ? [{ file, rule: 'xterm-css-global-import' }]
    : [];
}

const productionStringNeedles = [
  ['stage3-scenario-endpoint', '/api/v1/session/write-scenario'],
  ['stage4-scenario-endpoint', '/api/v1/session/run-scenario'],
  ['stage4-mock-ticket-prefix', 'mock-run-log-ticket-'],
  ['stage4-seed-log-marker', 'ensoai-stage4-seed-log'],
  ['stage4-mock-persistence-key', 'ensoai.mock.run-scenario.v1'],
  ['stage5-scenario-endpoint', '/api/v1/session/terminal-scenario'],
  ['stage5-mock-ticket-prefix', 'mock-terminal-ticket-'],
  ['stage5-mock-session-prefix', 'mock-terminal-session-'],
  ['stage5-mock-audit-prefix', 'mock-terminal-audit-'],
  ['stage5-stress-marker', 'ensoai-stage5-terminal-stress'],
  ['stage5-mock-persistence-key', 'ensoai.mock.terminal-scenario.v1'],
];

export function findForbiddenWorkbenchImports(file, source) {
  if (!isWorkbenchProductionModule(file)) return [];
  const rules = new Set();
  for (const specifier of extractImportSpecifiers(source)) {
    const rule = workbenchImportRule(file, specifier);
    if (rule) rules.add(rule);
  }
  for (const [rule, needle] of productionStringNeedles) {
    if (source.includes(needle)) rules.add(rule);
  }
  return toRuleResults(file, rules);
}

export function findForbiddenDistributionStrings(file, source) {
  const rules = new Set();
  for (const [rule, needle] of productionStringNeedles) {
    if (source.includes(needle)) rules.add(rule);
  }
  return toRuleResults(file, rules);
}

function htmlAttributes(tag) {
  const attributes = new Map();
  const pattern = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of tag.matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function parseInternalDistributionHref(href) {
  const withoutSuffix = href.split(/[?#]/, 1)[0].replaceAll('\\', '/');
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(withoutSuffix) || withoutSuffix.startsWith('//')) {
    return null;
  }
  const relative = path.posix.normalize(
    withoutSuffix.startsWith('/') ? withoutSuffix.slice(1) : withoutSuffix,
  );
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    return { href, relative: null };
  }
  return { href, relative: relative.replace(/^\.\//, '') };
}

function distributionPathVariants(relative) {
  const variants = [{ path: relative, allowAssetSuffix: false }];
  const assetsIndex = relative.indexOf('assets/');
  if (assetsIndex > 0 && relative[assetsIndex - 1] === '/') {
    variants.push({ path: relative.slice(assetsIndex), allowAssetSuffix: true });
  }
  return variants;
}

function resolveEntryStylesheetFiles(indexHtml, cssAssets) {
  const files = new Set();
  const violations = [];
  for (const match of indexHtml.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = htmlAttributes(match[0]);
    const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? [];
    const href = attributes.get('href');
    if (!rel.includes('stylesheet') || href === undefined) continue;
    const parsed = parseInternalDistributionHref(href);
    if (parsed === null) continue;
    const variants = parsed.relative === null ? [] : distributionPathVariants(parsed.relative);
    const candidates = cssAssets
      .map(({ file }) => file)
      .filter((file) => variants.some(({ path: variant, allowAssetSuffix }) =>
        file === `dist/${variant}` || (allowAssetSuffix && file.endsWith(`/${variant}`))));
    if (candidates.length === 0) {
      violations.push({ file: 'dist/index.html', rule: `xterm-css-entry-asset-missing:${href}` });
    } else if (candidates.length > 1) {
      violations.push({ file: 'dist/index.html', rule: `xterm-css-entry-asset-ambiguous:${href}` });
    } else {
      files.add(candidates[0]);
    }
  }
  return { files, violations };
}

export function findTerminalCssDistributionViolations(indexHtml, assets) {
  const cssAssets = assets
    .map(({ file, source }) => ({ file: toPosix(file), source }))
    .filter(({ file }) => path.posix.extname(file) === '.css');
  const cssByFile = new Map(cssAssets.map((asset) => [asset.file, asset.source]));
  const { files: entryFiles, violations } = resolveEntryStylesheetFiles(indexHtml, cssAssets);
  for (const file of entryFiles) {
    if (cssByFile.get(file)?.includes('.xterm')) {
      violations.push({ file, rule: 'xterm-css-entry-asset' });
    }
  }
  const hasLazyXtermCss = cssAssets.some(
    ({ file, source }) => !entryFiles.has(file) && source.includes('.xterm'),
  );
  if (!hasLazyXtermCss) {
    violations.push({ file: 'dist/index.html', rule: 'xterm-css-lazy-asset-missing' });
  }
  return violations;
}

const forbiddenContractNames = ['pvcName', 'podName', 'jobName', 'namespace', 'serviceAccount'];
const forbiddenContractNameSet = new Set(forbiddenContractNames);

function isContractNameScanTarget(file) {
  const normalized = toPosix(file);
  return (
    normalized.startsWith('src/contracts/') ||
    normalized.startsWith('src/features/files/') ||
    normalized.startsWith('src/features/runs/') ||
    normalized.startsWith('src/features/logs/') ||
    normalized.startsWith('src/features/terminal/') ||
    normalized.startsWith('src/components/runs/') ||
    normalized.startsWith('src/components/terminal/') ||
    normalized === 'src/api/runApi.ts' ||
    normalized === 'src/api/terminalApi.ts'
  );
}

function skipQuoted(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipQuoted(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function readQuoted(source, start) {
  const quote = source[start];
  let content = '';
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      content += source[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (source[i] === quote) return { content, end: i + 1 };
    content += source[i];
    i += 1;
  }
  return { content, end: source.length };
}

function previousNonSpace(source, index) {
  let i = index;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  return i;
}

function scanForbiddenContractNames(source) {
  const found = [];
  const seen = new Set();
  const add = (name) => {
    if (!seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      const { content, end } = readQuoted(source, i);
      i = end;
      if (!forbiddenContractNameSet.has(content)) continue;
      const afterColon = /^\s*:/.test(source.slice(end));
      const prev = previousNonSpace(source, start - 1);
      const bracketAccess = source[prev] === '[' && /^\s*\]/.test(source.slice(end));
      if (afterColon || bracketAccess) add(content);
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[\w$]/.test(source[j])) j += 1;
      const ident = source.slice(i, j);
      if (forbiddenContractNameSet.has(ident)) add(ident);
      i = j;
      continue;
    }
    i += 1;
  }
  return found;
}

export function findForbiddenContractNames(file, source) {
  if (!isContractNameScanTarget(file)) return [];
  return scanForbiddenContractNames(stripComments(source)).map((name) => ({
    file,
    rule: `contract-name:${name}`,
  }));
}
