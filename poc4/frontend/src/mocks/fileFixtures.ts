import type { FileBlockReason, FileRenderMode } from '../contracts/file';

const TEXT_LIMIT_BYTES = 20 * 1024 * 1024;
const MARKDOWN_LIMIT_BYTES = 50 * 1024 * 1024;
const NEAR_LIMIT_BYTES = 20 * 1024 * 1024 - 1;
const LARGE_NOTES_BYTES = 20 * 1024 * 1024 + 1;
const utf8 = new TextEncoder();

const ALICE_PROJECT_ID = 'prj-alice-notebook';
const BOB_PROJECT_ID = 'prj-bob-lab';

const PNG_1X1 = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45,
  180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);
const LATIN1_CAFE = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

export type LargeFileBodyKind = 'near-limit-java' | 'large-notes-md';

export type MockFileRecord = {
  path: string;
  name: string;
  sizeBytes: number;
  mediaType: string;
  encoding: 'UTF-8' | null;
  language: string;
  renderMode: FileRenderMode;
  blockReason: FileBlockReason | null;
  textContent: string | null;
  binaryContent: Uint8Array | null;
  largeBodyKind: LargeFileBodyKind | null;
};

type FileEncodingKind = 'utf8' | 'binary' | 'latin1';

type FileSpec = {
  path: string;
  textContent?: string;
  binaryContent?: Uint8Array;
  sizeBytes?: number;
  encodingKind?: FileEncodingKind;
  largeBodyKind?: LargeFileBodyKind;
};

type MockWorkspace = {
  files: Map<string, MockFileRecord>;
  directories: Set<string>;
  children: Map<string, string[]>;
  revision: string;
};

let nearLimitBodyCache: string | undefined;
let largeNotesBodyCache: string | undefined;

export function clearLargeFileBodyCache(): void {
  nearLimitBodyCache = undefined;
  largeNotesBodyCache = undefined;
}

function fileName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function isMarkdown(path: string): boolean {
  return fileName(path).endsWith('.md');
}

function languageFor(path: string): string {
  const name = fileName(path);
  if (name.endsWith('.java')) {
    return 'java';
  }
  if (name.endsWith('.xml')) {
    return 'xml';
  }
  if (name.endsWith('.md')) {
    return 'markdown';
  }
  if (name === '.gitignore') {
    return 'ignore';
  }
  if (name.endsWith('.png')) {
    return '';
  }
  return 'plaintext';
}

function mediaTypeFor(path: string): string {
  const name = fileName(path);
  if (name.endsWith('.png')) {
    return 'image/png';
  }
  if (name.endsWith('.xml')) {
    return 'application/xml';
  }
  if (name.endsWith('.md')) {
    return 'text/markdown';
  }
  if (name.endsWith('.csv')) {
    return 'text/csv';
  }
  return 'text/plain';
}

function sizePolicy(
  path: string,
  sizeBytes: number,
): { renderMode: FileRenderMode; blockReason: FileBlockReason | null; encoding: 'UTF-8' } {
  if (isMarkdown(path)) {
    if (sizeBytes <= TEXT_LIMIT_BYTES) {
      return { renderMode: 'MONACO_TEXT', blockReason: null, encoding: 'UTF-8' };
    }
    if (sizeBytes <= MARKDOWN_LIMIT_BYTES) {
      return { renderMode: 'PLAIN_TEXT', blockReason: null, encoding: 'UTF-8' };
    }
    return { renderMode: 'BLOCKED', blockReason: 'FILE_TOO_LARGE', encoding: 'UTF-8' };
  }
  if (sizeBytes <= TEXT_LIMIT_BYTES) {
    return { renderMode: 'MONACO_TEXT', blockReason: null, encoding: 'UTF-8' };
  }
  return { renderMode: 'BLOCKED', blockReason: 'FILE_TOO_LARGE', encoding: 'UTF-8' };
}

function buildFile(spec: FileSpec): MockFileRecord {
  const name = fileName(spec.path);
  const encodingKind = spec.encodingKind ?? 'utf8';
  const textContent = spec.textContent ?? null;
  const binaryContent = spec.binaryContent ?? null;
  let sizeBytes = spec.sizeBytes;
  if (sizeBytes === undefined) {
    sizeBytes =
      binaryContent !== null ? binaryContent.byteLength : utf8.encode(textContent ?? '').byteLength;
  }

  let renderMode: FileRenderMode;
  let blockReason: FileBlockReason | null;
  let encoding: 'UTF-8' | null;
  if (encodingKind === 'binary') {
    renderMode = 'BLOCKED';
    blockReason = 'BINARY_FILE';
    encoding = null;
  } else if (encodingKind === 'latin1') {
    renderMode = 'BLOCKED';
    blockReason = 'UNSUPPORTED_ENCODING';
    encoding = null;
  } else {
    const policy = sizePolicy(spec.path, sizeBytes);
    renderMode = policy.renderMode;
    blockReason = policy.blockReason;
    encoding = policy.encoding;
  }

  return {
    path: spec.path,
    name,
    sizeBytes,
    mediaType: mediaTypeFor(spec.path),
    encoding,
    language: languageFor(spec.path),
    renderMode,
    blockReason,
    textContent,
    binaryContent,
    largeBodyKind: spec.largeBodyKind ?? null,
  };
}

function emptyWorkspace(revision: string): MockWorkspace {
  return {
    files: new Map(),
    directories: new Set(['']),
    children: new Map([['', []]]),
    revision,
  };
}

function appendChild(workspace: MockWorkspace, parent: string, child: string): void {
  const list = workspace.children.get(parent);
  if (list === undefined) {
    workspace.children.set(parent, [child]);
    return;
  }
  if (!list.includes(child)) {
    list.push(child);
  }
}

function ensureDir(workspace: MockWorkspace, dir: string): void {
  if (workspace.directories.has(dir)) {
    return;
  }
  workspace.directories.add(dir);
  if (!workspace.children.has(dir)) {
    workspace.children.set(dir, []);
  }
  if (dir !== '') {
    const parent = parentOf(dir);
    ensureDir(workspace, parent);
    appendChild(workspace, parent, dir);
  }
}

function buildWorkspace(revision: string, specs: readonly FileSpec[]): MockWorkspace {
  const workspace = emptyWorkspace(revision);
  for (const spec of specs) {
    const file = buildFile(spec);
    workspace.files.set(file.path, file);
    const parent = parentOf(file.path);
    ensureDir(workspace, parent);
    appendChild(workspace, parent, file.path);
  }
  return workspace;
}

function padAscii(prefix: string, suffix: string, sizeBytes: number): string {
  const pad = sizeBytes - prefix.length - suffix.length;
  if (pad < 0) {
    throw new Error('Large-file template exceeds target size');
  }
  return `${prefix}${'a'.repeat(pad)}${suffix}`;
}

function nearLimitBody(): string {
  if (nearLimitBodyCache === undefined) {
    nearLimitBodyCache = padAscii(
      'package demo;\n\npublic class NearLimit {\n  public static final String DATA = "',
      '";\n}\n',
      NEAR_LIMIT_BYTES,
    );
  }
  return nearLimitBodyCache;
}

function largeNotesBody(): string {
  if (largeNotesBodyCache === undefined) {
    largeNotesBodyCache = padAscii('# Large notes\n\n', '\n', LARGE_NOTES_BYTES);
  }
  return largeNotesBodyCache;
}

const ALICE_FILES: readonly FileSpec[] = [
  {
    path: '.gitignore',
    textContent: 'target/\n*.class\n',
  },
  {
    path: 'README.md',
    textContent: '# Alice Notebook\n\nRead-only Maven demo.\n',
  },
  {
    path: 'pom.xml',
    textContent: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>demo</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
</project>
`,
  },
  {
    path: 'assets/logo.png',
    binaryContent: PNG_1X1,
    encodingKind: 'binary',
  },
  {
    path: 'docs/large-notes.md',
    textContent: '# Large notes\n\nPlaceholder for the oversized Markdown fixture.\n',
    sizeBytes: LARGE_NOTES_BYTES,
    largeBodyKind: 'large-notes-md',
  },
  {
    path: 'docs/too-large.md',
    textContent: '# Too large\n\nPlaceholder. Content is not served.\n',
    sizeBytes: 50 * 1024 * 1024 + 1,
  },
  {
    path: 'docs/latin1.txt',
    binaryContent: LATIN1_CAFE,
    encodingKind: 'latin1',
  },
  {
    path: 'docs/exact-20mib.md',
    textContent: '# Exact 20 MiB\n\nMetadata size is 20 MiB. Body stays small.\n',
    sizeBytes: 20 * 1024 * 1024,
  },
  {
    path: 'docs/exact-50mib.md',
    textContent: '# Exact 50 MiB\n\nMetadata size is 50 MiB. Body stays small.\n',
    sizeBytes: 50 * 1024 * 1024,
  },
  {
    path: 'src/main/java/demo/App.java',
    textContent: `package demo;

public class App {
  public static void main(String[] args) {
    System.out.println("Hello, POC4");
  }
}
`,
  },
  {
    path: 'src/main/java/demo/NearLimit.java',
    textContent: `package demo;

public class NearLimit {
  public static void main(String[] args) {
    System.out.println("near-limit");
  }
}
`,
    sizeBytes: NEAR_LIMIT_BYTES,
    largeBodyKind: 'near-limit-java',
  },
  {
    path: 'src/test/java/demo/AppTest.java',
    textContent: `package demo;

public class AppTest {
  public static void main(String[] args) {
    System.out.println("ok");
  }
}
`,
  },
];

const BOB_FILES: readonly FileSpec[] = [
  {
    path: 'lab-notes.md',
    textContent: '# Bob Lab\n\nDistinct from Alice Maven tree.\n',
  },
  {
    path: 'samples/result.csv',
    textContent: 'sample,value\na,1\n',
  },
];

const EMPTY_WORKSPACE = emptyWorkspace('rev-workspace');

const WORKSPACES = new Map<string, MockWorkspace>([
  [ALICE_PROJECT_ID, buildWorkspace('rev-alice-notebook', ALICE_FILES)],
  [BOB_PROJECT_ID, buildWorkspace('rev-bob-lab', BOB_FILES)],
]);

function workspaceFor(projectId: string): MockWorkspace {
  return WORKSPACES.get(projectId) ?? EMPTY_WORKSPACE;
}

export function getWorkspaceRevision(projectId: string): string {
  return workspaceFor(projectId).revision;
}

export function directoryExists(projectId: string, path: string): boolean {
  return workspaceFor(projectId).directories.has(path);
}

export function getMockFile(projectId: string, path: string): MockFileRecord | null {
  return workspaceFor(projectId).files.get(path) ?? null;
}

export function listDirectoryEntries(
  projectId: string,
  directory: string,
): Array<{
  path: string;
  name: string;
  kind: 'file' | 'directory';
  hidden: boolean;
  sizeBytes: number | null;
  hasChildren: boolean | null;
}> | null {
  const workspace = workspaceFor(projectId);
  if (!workspace.directories.has(directory)) {
    return null;
  }
  const childPaths = workspace.children.get(directory) ?? [];
  return childPaths.map((childPath) => {
    const file = workspace.files.get(childPath);
    if (file !== undefined) {
      return {
        path: file.path,
        name: file.name,
        kind: 'file',
        hidden: file.name.startsWith('.'),
        sizeBytes: file.sizeBytes,
        hasChildren: null,
      };
    }
    const name = fileName(childPath);
    const grandchildren = workspace.children.get(childPath) ?? [];
    return {
      path: childPath,
      name,
      kind: 'directory',
      hidden: name.startsWith('.'),
      sizeBytes: null,
      hasChildren: grandchildren.length > 0,
    };
  });
}

export function toFileMetadataJson(file: MockFileRecord) {
  return {
    path: file.path,
    name: file.name,
    sizeBytes: file.sizeBytes,
    mediaType: file.mediaType,
    encoding: file.encoding,
    language: file.language,
    renderMode: file.renderMode,
    blockReason: file.blockReason,
  };
}

export function resolveFileText(file: MockFileRecord, largeBodiesEnabled: boolean): string {
  if (largeBodiesEnabled && file.largeBodyKind === 'near-limit-java') {
    return nearLimitBody();
  }
  if (largeBodiesEnabled && file.largeBodyKind === 'large-notes-md') {
    return largeNotesBody();
  }
  return file.textContent ?? '';
}

export function resolveFileBytes(file: MockFileRecord, largeBodiesEnabled: boolean): Uint8Array {
  if (file.binaryContent !== null) {
    return file.binaryContent;
  }
  return utf8.encode(resolveFileText(file, largeBodiesEnabled));
}

export function sanitizeDownloadFilename(name: string): string {
  let cleaned = '';
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127 || char === '/' || char === '\\' || char === '"') {
      continue;
    }
    cleaned += char;
  }
  cleaned = cleaned.trim();
  return cleaned === '' ? 'download' : cleaned;
}

export function contentDispositionHeader(name: string): string {
  return `attachment; filename="${sanitizeDownloadFilename(name)}"`;
}
