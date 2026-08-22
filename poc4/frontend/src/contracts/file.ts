import {
  parseProjectDirectoryPath,
  parseProjectRelativePath,
} from '../features/files/pathPolicy';

declare const projectRelativePathBrand: unique symbol;

export type ProjectRelativePath = string & {
  readonly [projectRelativePathBrand]: true;
};

export type ProjectDirectoryPath = ProjectRelativePath | '';

export type FileTreeEntry = {
  path: ProjectRelativePath;
  name: string;
  kind: 'file' | 'directory';
  hidden: boolean;
  sizeBytes: number | null;
  hasChildren: boolean | null;
};

export type FileTreeResponse = {
  directory: ProjectDirectoryPath;
  entries: FileTreeEntry[];
};

export type FileRenderMode = 'MONACO_TEXT' | 'PLAIN_TEXT' | 'BLOCKED';
export type FileBlockReason =
  | 'BINARY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_ENCODING';

export type FileMetadata = {
  path: ProjectRelativePath;
  name: string;
  sizeBytes: number;
  mediaType: string;
  encoding: 'UTF-8' | null;
  language: string;
  renderMode: FileRenderMode;
  blockReason: FileBlockReason | null;
};

export type FileContentResponse = {
  path: ProjectRelativePath;
  content: string;
  workspaceRevision: string;
};

const INVALID_FILE_RESPONSE = 'Invalid file response';

function invalidFileResponse(): never {
  throw new Error(INVALID_FILE_RESPONSE);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidFileResponse();
  }
  return value as Record<string, unknown>;
}

function parseNonNegativeFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalidFileResponse();
  }
  return value;
}

function parseEntryName(path: ProjectRelativePath, name: unknown): string {
  if (typeof name !== 'string' || name === '') {
    invalidFileResponse();
  }
  const expected = path.slice(path.lastIndexOf('/') + 1);
  if (name !== expected) {
    invalidFileResponse();
  }
  return name;
}

function parseResponseRelativePath(value: unknown): ProjectRelativePath {
  if (typeof value !== 'string') {
    invalidFileResponse();
  }
  try {
    return parseProjectRelativePath(value);
  } catch {
    invalidFileResponse();
  }
}

function parseResponseDirectoryPath(value: unknown): ProjectDirectoryPath {
  if (typeof value !== 'string') {
    invalidFileResponse();
  }
  try {
    return parseProjectDirectoryPath(value);
  } catch {
    invalidFileResponse();
  }
}

function parentDirectory(path: ProjectRelativePath): ProjectDirectoryPath {
  const index = path.lastIndexOf('/');
  if (index === -1) {
    return '';
  }
  return parseProjectDirectoryPath(path.slice(0, index));
}

function parseFileTreeEntry(value: unknown): FileTreeEntry {
  const record = asRecord(value);
  const path = parseResponseRelativePath(record.path);
  const name = parseEntryName(path, record.name);
  if (typeof record.hidden !== 'boolean') {
    invalidFileResponse();
  }
  if (record.kind === 'file') {
    if (record.hasChildren !== null) {
      invalidFileResponse();
    }
    return {
      path,
      name,
      kind: 'file',
      hidden: record.hidden,
      sizeBytes: parseNonNegativeFiniteNumber(record.sizeBytes),
      hasChildren: null,
    };
  }
  if (record.kind !== 'directory') {
    invalidFileResponse();
  }
  if (record.sizeBytes !== null) {
    invalidFileResponse();
  }
  if (typeof record.hasChildren !== 'boolean') {
    invalidFileResponse();
  }
  return {
    path,
    name,
    kind: 'directory',
    hidden: record.hidden,
    sizeBytes: null,
    hasChildren: record.hasChildren,
  };
}

export function parseFileTreeResponse(
  value: unknown,
  expectedDirectory: ProjectDirectoryPath,
): FileTreeResponse {
  const record = asRecord(value);
  const directory = parseResponseDirectoryPath(record.directory);
  if (directory !== expectedDirectory) {
    invalidFileResponse();
  }
  if (!Array.isArray(record.entries)) {
    invalidFileResponse();
  }
  const entries = record.entries.map(parseFileTreeEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (parentDirectory(entry.path) !== directory || seen.has(entry.path)) {
      invalidFileResponse();
    }
    seen.add(entry.path);
  }
  return { directory, entries };
}

function parseRenderMode(value: unknown): FileRenderMode {
  if (value !== 'MONACO_TEXT' && value !== 'PLAIN_TEXT' && value !== 'BLOCKED') {
    invalidFileResponse();
  }
  return value;
}

function parseBlockReason(value: unknown): FileBlockReason | null {
  if (
    value !== null &&
    value !== 'BINARY_FILE' &&
    value !== 'FILE_TOO_LARGE' &&
    value !== 'UNSUPPORTED_ENCODING'
  ) {
    invalidFileResponse();
  }
  return value;
}

export function parseFileMetadata(
  value: unknown,
  expectedPath: ProjectRelativePath,
): FileMetadata {
  const record = asRecord(value);
  const path = parseResponseRelativePath(record.path);
  if (path !== expectedPath) {
    invalidFileResponse();
  }
  const name = parseEntryName(path, record.name);
  const sizeBytes = parseNonNegativeFiniteNumber(record.sizeBytes);
  if (typeof record.mediaType !== 'string' || typeof record.language !== 'string') {
    invalidFileResponse();
  }
  if (record.encoding !== 'UTF-8' && record.encoding !== null) {
    invalidFileResponse();
  }
  const renderMode = parseRenderMode(record.renderMode);
  const blockReason = parseBlockReason(record.blockReason);
  if (renderMode === 'MONACO_TEXT' || renderMode === 'PLAIN_TEXT') {
    if (record.encoding !== 'UTF-8' || blockReason !== null) {
      invalidFileResponse();
    }
  } else if (blockReason === null) {
    invalidFileResponse();
  } else if (
    (blockReason === 'BINARY_FILE' || blockReason === 'UNSUPPORTED_ENCODING') &&
    record.encoding !== null
  ) {
    invalidFileResponse();
  }
  return {
    path,
    name,
    sizeBytes,
    mediaType: record.mediaType,
    encoding: record.encoding,
    language: record.language,
    renderMode,
    blockReason,
  };
}

export function parseFileContentResponse(
  value: unknown,
  expectedPath: ProjectRelativePath,
): FileContentResponse {
  const record = asRecord(value);
  const path = parseResponseRelativePath(record.path);
  if (path !== expectedPath) {
    invalidFileResponse();
  }
  if (typeof record.content !== 'string') {
    invalidFileResponse();
  }
  if (typeof record.workspaceRevision !== 'string' || record.workspaceRevision === '') {
    invalidFileResponse();
  }
  return {
    path,
    content: record.content,
    workspaceRevision: record.workspaceRevision,
  };
}
