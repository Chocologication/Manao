import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileContentResponse, FileMetadata, FileTreeResponse } from '../contracts/file';
import {
  parseCreateEntryResponse,
  parseDeleteEntryResponse,
  parseFileContentResponse,
  parseFileMetadata,
  parseFileTreeResponse,
  parseRenameEntryResponse,
  parseSaveFileResponse,
  parseWorkspaceRevision,
} from '../contracts/file';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../features/files/pathPolicy';
import {
  createEntry,
  deleteEntry,
  downloadFileBlob,
  getFileContent,
  getFileMetadata,
  listDirectory,
  renameEntry,
  saveFileContent,
} from './fileApi';
import { HttpClient, setHttpClient } from './httpClient';

const PROJECT_ID = 'prj/opaque';
const FILE_PATH = 'src/main/java/demo/App.java';

const monacoMetadata: FileMetadata = {
  path: FILE_PATH as FileMetadata['path'],
  name: 'App.java',
  sizeBytes: 128,
  mediaType: 'text/plain',
  encoding: 'UTF-8',
  language: 'java',
  renderMode: 'MONACO_TEXT',
  blockReason: null,
};

const fileContent: FileContentResponse = {
  path: FILE_PATH as FileContentResponse['path'],
  content: 'class App {}',
  workspaceRevision: 'rev-1' as FileContentResponse['workspaceRevision'],
};

const srcTree: FileTreeResponse = {
  directory: 'src' as FileTreeResponse['directory'],
  entries: [
    {
      path: 'src/App.java' as FileTreeResponse['entries'][number]['path'],
      name: 'App.java',
      kind: 'file',
      hidden: false,
      sizeBytes: 128,
      hasChildren: null,
    },
    {
      path: 'src/main' as FileTreeResponse['entries'][number]['path'],
      name: 'main',
      kind: 'directory',
      hidden: false,
      sizeBytes: null,
      hasChildren: true,
    },
  ],
  workspaceRevision: 'rev-1' as FileTreeResponse['workspaceRevision'],
};

const newFileEntry = {
  path: 'src/New.java',
  name: 'New.java',
  kind: 'file' as const,
  hidden: false,
  sizeBytes: 0,
  hasChildren: null,
};

const newFileMetadata: FileMetadata = {
  path: 'src/New.java' as FileMetadata['path'],
  name: 'New.java',
  sizeBytes: 0,
  mediaType: 'text/plain',
  encoding: 'UTF-8',
  language: 'java',
  renderMode: 'MONACO_TEXT',
  blockReason: null,
};

const newDirectoryEntry = {
  path: 'src/util',
  name: 'util',
  kind: 'directory' as const,
  hidden: false,
  sizeBytes: null,
  hasChildren: false,
};

const createFilePayload = {
  entry: newFileEntry,
  file: newFileMetadata,
  workspaceRevision: 'rev-2',
};

const createDirectoryPayload = {
  entry: newDirectoryEntry,
  file: null,
  workspaceRevision: 'rev-2',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function blobResponse(body: BlobPart, contentDisposition?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
  if (contentDisposition !== undefined) {
    headers.set('Content-Disposition', contentDisposition);
  }
  return new Response(body, { status: 200, headers });
}

function installClient(
  fetchImpl: typeof fetch,
  getAccessToken: () => string | null = () => 'access-token',
) {
  const onUnauthorized = vi.fn();
  setHttpClient(
    new HttpClient({
      getAccessToken,
      onUnauthorized,
      fetchImpl,
    }),
  );
  return { onUnauthorized };
}

function callUrl(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): URL {
  return new URL(String(fetchImpl.mock.calls[index]?.[0]), 'http://app.local');
}

function authorizationHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('Authorization');
}

afterEach(() => {
  setHttpClient(null);
});

describe('file API URL construction', () => {
  it('GETs metadata with encoded project id and URLSearchParams path', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(monacoMetadata));
    installClient(fetchImpl);
    const path = parseProjectRelativePath(FILE_PATH);

    await expect(getFileMetadata(PROJECT_ID, path)).resolves.toEqual(monacoMetadata);

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i);
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/files/meta');
    expect(requestUrl.searchParams.get('path')).toBe('src/main/java/demo/App.java');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
  });

  it('GETs directory trees including the project root', async () => {
    const rootTree = {
      directory: '',
      entries: [
        {
          path: '.gitignore',
          name: '.gitignore',
          kind: 'file',
          hidden: true,
          sizeBytes: 20,
          hasChildren: null,
        },
      ],
      workspaceRevision: 'rev-1',
    };
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(srcTree))
      .mockResolvedValueOnce(jsonResponse(rootTree));
    installClient(fetchImpl);

    await expect(
      listDirectory(PROJECT_ID, parseProjectDirectoryPath('src')),
    ).resolves.toEqual(srcTree);
    await expect(listDirectory(PROJECT_ID, parseProjectDirectoryPath(''))).resolves.toEqual(
      rootTree,
    );

    const treeUrl = callUrl(fetchImpl, 0);
    expect(fetchImpl.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i);
    expect(treeUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/files/tree');
    expect(treeUrl.searchParams.get('path')).toBe('src');

    const rootUrl = callUrl(fetchImpl, 1);
    expect(rootUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/files/tree');
    expect(rootUrl.searchParams.get('path')).toBe('');
  });

  it('GETs file content through the content route', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(fileContent));
    installClient(fetchImpl);

    await expect(
      getFileContent(PROJECT_ID, parseProjectRelativePath(FILE_PATH)),
    ).resolves.toEqual(fileContent);

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i);
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/files/content');
    expect(requestUrl.searchParams.get('path')).toBe(FILE_PATH);
  });

  it('GETs download bytes without putting the JWT in the URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      blobResponse('bytes', 'attachment; filename="App.java"'),
    );
    installClient(fetchImpl);
    const path = parseProjectRelativePath(FILE_PATH);

    const result = await downloadFileBlob(PROJECT_ID, path, 'App.java');

    expect(result.filename).toBe('App.java');
    expect(await result.blob.text()).toBe('bytes');
    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i);
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/files/download');
    expect(requestUrl.searchParams.get('path')).toBe(FILE_PATH);
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('access-token');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
  });

  it('requires branded paths rather than raw strings', () => {
    const path = parseProjectRelativePath(FILE_PATH);
    const directory = parseProjectDirectoryPath('src');
    expect(path).toBe(FILE_PATH);
    expect(directory).toBe('src');
    if (false) {
      // @ts-expect-error raw strings are not branded paths
      void listDirectory(PROJECT_ID, 'src');
      // @ts-expect-error raw strings are not branded paths
      void getFileMetadata(PROJECT_ID, FILE_PATH);
      // @ts-expect-error raw strings are not branded paths
      void getFileContent(PROJECT_ID, FILE_PATH);
      // @ts-expect-error raw strings are not branded paths
      void downloadFileBlob(PROJECT_ID, FILE_PATH, 'App.java');
      // @ts-expect-error raw strings are not branded paths
      void saveFileContent(PROJECT_ID, FILE_PATH, {
        content: '',
        expectedWorkspaceRevision: parseWorkspaceRevision('rev-1'),
      });
      void createEntry(PROJECT_ID, {
        kind: 'file',
        // @ts-expect-error raw strings are not branded paths
        path: FILE_PATH,
        expectedWorkspaceRevision: parseWorkspaceRevision('rev-1'),
      });
    }
  });
});

describe('file API response contracts', () => {
  it('parses a valid tree and preserves Unicode names', () => {
    const directory = parseProjectDirectoryPath('src');
    const unicodeTree = {
      directory: 'src',
      entries: [
        {
          path: 'src/你好.java',
          name: '你好.java',
          kind: 'file',
          hidden: false,
          sizeBytes: 4,
          hasChildren: null,
        },
      ],
      workspaceRevision: 'rev-1',
    };

    expect(parseFileTreeResponse(unicodeTree, directory)).toEqual(unicodeTree);
  });

  it('rejects a whole tree when any node is invalid', () => {
    const directory = parseProjectDirectoryPath('src');
    const payload = {
      directory: 'src',
      entries: [
        srcTree.entries[0],
        {
          path: 'src/broken',
          name: 'broken',
          kind: 'file',
          hidden: false,
          sizeBytes: 1,
          hasChildren: true,
        },
      ],
      workspaceRevision: 'rev-1',
    };

    expect(() => parseFileTreeResponse(payload, directory)).toThrow('Invalid file response');
  });

  it.each([
    [
      'duplicate sibling paths',
      {
        directory: 'src',
        entries: [srcTree.entries[0], srcTree.entries[0]],
        workspaceRevision: 'rev-1',
      },
    ],
    [
      'mismatched parent directory',
      {
        directory: 'src',
        entries: [
          {
            path: 'README.md',
            name: 'README.md',
            kind: 'file',
            hidden: false,
            sizeBytes: 10,
            hasChildren: null,
          },
        ],
        workspaceRevision: 'rev-1',
      },
    ],
    [
      'file with hasChildren',
      {
        directory: 'src',
        entries: [
          {
            path: 'src/App.java',
            name: 'App.java',
            kind: 'file',
            hidden: false,
            sizeBytes: 128,
            hasChildren: false,
          },
        ],
        workspaceRevision: 'rev-1',
      },
    ],
    [
      'directory with sizeBytes',
      {
        directory: 'src',
        entries: [
          {
            path: 'src/main',
            name: 'main',
            kind: 'directory',
            hidden: false,
            sizeBytes: 0,
            hasChildren: true,
          },
        ],
        workspaceRevision: 'rev-1',
      },
    ],
    [
      'negative size',
      {
        directory: 'src',
        entries: [
          {
            path: 'src/App.java',
            name: 'App.java',
            kind: 'file',
            hidden: false,
            sizeBytes: -1,
            hasChildren: null,
          },
        ],
        workspaceRevision: 'rev-1',
      },
    ],
  ])('rejects tree with %s', (_label, payload) => {
    expect(() =>
      parseFileTreeResponse(payload, parseProjectDirectoryPath('src')),
    ).toThrow('Invalid file response');
  });

  it('does not return a partial tree from listDirectory when a node is invalid', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        directory: 'src',
        entries: [
          srcTree.entries[0],
          {
            path: 'other/secret',
            name: 'secret',
            kind: 'file',
            hidden: false,
            sizeBytes: 1,
            hasChildren: null,
          },
        ],
        workspaceRevision: 'rev-1',
      }),
    );
    installClient(fetchImpl);

    await expect(
      listDirectory(PROJECT_ID, parseProjectDirectoryPath('src')),
    ).rejects.toThrow('Invalid file response');
  });

  it('accepts blocked metadata for binary, too-large, and unsupported encoding', () => {
    const path = parseProjectRelativePath('logo.png');
    expect(
      parseFileMetadata(
        {
          path: 'logo.png',
          name: 'logo.png',
          sizeBytes: 2048,
          mediaType: 'image/png',
          encoding: null,
          language: '',
          renderMode: 'BLOCKED',
          blockReason: 'BINARY_FILE',
        },
        path,
      ).blockReason,
    ).toBe('BINARY_FILE');

    const largePath = parseProjectRelativePath('too-large.md');
    expect(
      parseFileMetadata(
        {
          path: 'too-large.md',
          name: 'too-large.md',
          sizeBytes: 50 * 1024 * 1024 + 1,
          mediaType: 'text/markdown',
          encoding: 'UTF-8',
          language: 'markdown',
          renderMode: 'BLOCKED',
          blockReason: 'FILE_TOO_LARGE',
        },
        largePath,
      ).blockReason,
    ).toBe('FILE_TOO_LARGE');

    const encodedPath = parseProjectRelativePath('legacy.txt');
    expect(
      parseFileMetadata(
        {
          path: 'legacy.txt',
          name: 'legacy.txt',
          sizeBytes: 40,
          mediaType: 'text/plain',
          encoding: null,
          language: 'plaintext',
          renderMode: 'BLOCKED',
          blockReason: 'UNSUPPORTED_ENCODING',
        },
        encodedPath,
      ).blockReason,
    ).toBe('UNSUPPORTED_ENCODING');
  });

  it.each([
    ['negative size', { ...monacoMetadata, sizeBytes: -1 }],
    ['non-finite size', { ...monacoMetadata, sizeBytes: Number.POSITIVE_INFINITY }],
    ['monaco without utf-8', { ...monacoMetadata, encoding: null }],
    ['plain text without utf-8', { ...monacoMetadata, renderMode: 'PLAIN_TEXT', encoding: null }],
    ['monaco with block reason', { ...monacoMetadata, blockReason: 'BINARY_FILE' }],
    [
      'blocked without reason',
      { ...monacoMetadata, renderMode: 'BLOCKED', blockReason: null, encoding: null },
    ],
    [
      'binary with utf-8',
      {
        ...monacoMetadata,
        renderMode: 'BLOCKED',
        blockReason: 'BINARY_FILE',
        encoding: 'UTF-8',
      },
    ],
    [
      'unsupported encoding with utf-8',
      {
        ...monacoMetadata,
        renderMode: 'BLOCKED',
        blockReason: 'UNSUPPORTED_ENCODING',
        encoding: 'UTF-8',
      },
    ],
    ['path mismatch', { ...monacoMetadata, path: 'src/Other.java', name: 'Other.java' }],
  ])('rejects metadata %s', (_label, payload) => {
    expect(() =>
      parseFileMetadata(payload, parseProjectRelativePath(FILE_PATH)),
    ).toThrow('Invalid file response');
  });

  it('rejects invalid content payloads', () => {
    const path = parseProjectRelativePath(FILE_PATH);
    expect(() => parseFileContentResponse({ ...fileContent, content: 1 }, path)).toThrow(
      'Invalid file response',
    );
    expect(() =>
      parseFileContentResponse({ ...fileContent, workspaceRevision: '' }, path),
    ).toThrow('Invalid file response');
    expect(() =>
      parseFileContentResponse({ ...fileContent, path: 'src/Other.java' }, path),
    ).toThrow('Invalid file response');
  });

  it('getFileMetadata and getFileContent throw Invalid file response on bad JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ ...monacoMetadata, encoding: null }))
      .mockResolvedValueOnce(jsonResponse({ ...fileContent, content: null }));
    installClient(fetchImpl);
    const path = parseProjectRelativePath(FILE_PATH);

    await expect(getFileMetadata(PROJECT_ID, path)).rejects.toThrow('Invalid file response');
    await expect(getFileContent(PROJECT_ID, path)).rejects.toThrow('Invalid file response');
  });
});

describe('workspace revision contract', () => {
  it('accepts a non-empty opaque token up to 256 UTF-16 code units', () => {
    expect(parseWorkspaceRevision('rev-1')).toBe('rev-1');
    expect(parseWorkspaceRevision('x'.repeat(256))).toBe('x'.repeat(256));
    expect(parseWorkspaceRevision(' mock-rev/0002 ')).toBe(' mock-rev/0002 ');
  });

  it.each([
    ['empty', ''],
    ['oversized', 'x'.repeat(257)],
    ['non-string', 1],
  ])('rejects %s revision with a single safe error', (_label, value) => {
    expect(() => parseWorkspaceRevision(value)).toThrow('Invalid file response');
  });

  it('requires a branded revision on tree and content responses', () => {
    const directory = parseProjectDirectoryPath('src');
    expect(() =>
      parseFileTreeResponse({ directory: 'src', entries: srcTree.entries }, directory),
    ).toThrow('Invalid file response');
    expect(() =>
      parseFileTreeResponse({ ...srcTree, workspaceRevision: '' }, directory),
    ).toThrow('Invalid file response');
    expect(() =>
      parseFileTreeResponse({ ...srcTree, workspaceRevision: 'x'.repeat(257) }, directory),
    ).toThrow('Invalid file response');
    expect(() =>
      parseFileContentResponse(
        { ...fileContent, workspaceRevision: 'x'.repeat(257) },
        parseProjectRelativePath(FILE_PATH),
      ),
    ).toThrow('Invalid file response');
  });
});

describe('mutation response contracts', () => {
  it('parses save, create, rename and delete success bodies', () => {
    const filePath = parseProjectRelativePath(FILE_PATH);
    const newPath = parseProjectRelativePath('src/New.java');
    const dirPath = parseProjectRelativePath('src/util');
    const nextPath = parseProjectRelativePath('src/Renamed.java');

    expect(
      parseSaveFileResponse(
        { file: monacoMetadata, workspaceRevision: 'rev-2' },
        filePath,
      ),
    ).toEqual({ file: monacoMetadata, workspaceRevision: 'rev-2' });
    expect(parseCreateEntryResponse(createFilePayload, newPath, 'file')).toEqual(createFilePayload);
    expect(parseCreateEntryResponse(createDirectoryPayload, dirPath, 'directory')).toEqual(
      createDirectoryPayload,
    );
    expect(
      parseRenameEntryResponse(
        {
          path: FILE_PATH,
          nextPath: 'src/Renamed.java',
          entry: { ...newFileEntry, path: 'src/Renamed.java', name: 'Renamed.java' },
          file: { ...newFileMetadata, path: 'src/Renamed.java', name: 'Renamed.java' },
          workspaceRevision: 'rev-3',
        },
        filePath,
        nextPath,
      ),
    ).toMatchObject({ path: FILE_PATH, nextPath: 'src/Renamed.java', workspaceRevision: 'rev-3' });
    expect(
      parseDeleteEntryResponse({ path: FILE_PATH, workspaceRevision: 'rev-4' }, filePath),
    ).toEqual({ path: FILE_PATH, workspaceRevision: 'rev-4' });
  });

  it.each([
    [
      'empty revision',
      () =>
        parseSaveFileResponse(
          { file: monacoMetadata, workspaceRevision: '' },
          parseProjectRelativePath(FILE_PATH),
        ),
    ],
    [
      'oversized revision',
      () =>
        parseDeleteEntryResponse(
          { path: FILE_PATH, workspaceRevision: 'x'.repeat(257) },
          parseProjectRelativePath(FILE_PATH),
        ),
    ],
    [
      'request/response path mismatch',
      () =>
        parseSaveFileResponse(
          { file: { ...monacoMetadata, path: 'src/Other.java', name: 'Other.java' }, workspaceRevision: 'rev-2' },
          parseProjectRelativePath(FILE_PATH),
        ),
    ],
    [
      'wrong entry kind',
      () =>
        parseCreateEntryResponse(createDirectoryPayload, parseProjectRelativePath('src/util'), 'file'),
    ],
    [
      'parent mismatch',
      () =>
        parseCreateEntryResponse(
          {
            ...createFilePayload,
            entry: { ...newFileEntry, path: 'docs/New.java' },
            file: { ...newFileMetadata, path: 'docs/New.java' },
          },
          parseProjectRelativePath('src/New.java'),
          'file',
        ),
    ],
    [
      'mismatched file metadata',
      () =>
        parseCreateEntryResponse(
          {
            ...createFilePayload,
            file: { ...newFileMetadata, path: FILE_PATH, name: 'App.java' },
          },
          parseProjectRelativePath('src/New.java'),
          'file',
        ),
    ],
    [
      'duplicate fields that violate invariants',
      () =>
        parseCreateEntryResponse(
          { ...createDirectoryPayload, file: newFileMetadata },
          parseProjectRelativePath('src/util'),
          'directory',
        ),
    ],
    [
      'forbidden physical identifiers',
      () =>
        parseRenameEntryResponse(
          {
            path: 'C:\\Users\\repo\\App.java',
            nextPath: 'src/Renamed.java',
            entry: { ...newFileEntry, path: 'src/Renamed.java', name: 'Renamed.java' },
            file: { ...newFileMetadata, path: 'src/Renamed.java', name: 'Renamed.java' },
            workspaceRevision: 'rev-3',
          },
          parseProjectRelativePath(FILE_PATH),
          parseProjectRelativePath('src/Renamed.java'),
        ),
    ],
  ])('rejects mutation with %s', (_label, parse) => {
    expect(parse).toThrow('Invalid file response');
  });

  it('does not return a partial mutation result from saveFileContent', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ file: monacoMetadata, workspaceRevision: '' }),
    );
    installClient(fetchImpl);

    await expect(
      saveFileContent(PROJECT_ID, parseProjectRelativePath(FILE_PATH), {
        content: 'class App {}',
        expectedWorkspaceRevision: parseWorkspaceRevision('rev-1'),
      }),
    ).rejects.toThrow('Invalid file response');
  });
});

describe('file mutation API URL construction', () => {
  it('PUTs file content with encoded project id, URLSearchParams path and revision body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ file: monacoMetadata, workspaceRevision: 'rev-2' }),
    );
    installClient(fetchImpl);
    const path = parseProjectRelativePath(FILE_PATH);
    const expectedWorkspaceRevision = parseWorkspaceRevision('rev-1');

    await expect(
      saveFileContent(PROJECT_ID, path, {
        content: 'class App {}',
        expectedWorkspaceRevision,
      }),
    ).resolves.toEqual({ file: monacoMetadata, workspaceRevision: 'rev-2' });

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('PUT');
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/files/content');
    expect(requestUrl.searchParams.get('path')).toBe(FILE_PATH);
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('access-token');
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain('access-token');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        content: 'class App {}',
        expectedWorkspaceRevision: 'rev-1',
      }),
    );
  });

  it('POSTs createEntry with branded path and revision in the JSON body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(createFilePayload));
    installClient(fetchImpl);
    const path = parseProjectRelativePath('src/New.java');

    await expect(
      createEntry(PROJECT_ID, {
        kind: 'file',
        path,
        expectedWorkspaceRevision: parseWorkspaceRevision('rev-1'),
      }),
    ).resolves.toEqual(createFilePayload);

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/entries');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('access-token');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        kind: 'file',
        path: 'src/New.java',
        expectedWorkspaceRevision: 'rev-1',
      }),
    );
  });

  it('POSTs renameEntry with current and next branded paths', async () => {
    const nextPath = 'src/Renamed.java';
    const payload = {
      path: FILE_PATH,
      nextPath,
      entry: { ...newFileEntry, path: nextPath, name: 'Renamed.java' },
      file: { ...newFileMetadata, path: nextPath, name: 'Renamed.java' },
      workspaceRevision: 'rev-3',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(payload));
    installClient(fetchImpl);

    await expect(
      renameEntry(PROJECT_ID, {
        path: parseProjectRelativePath(FILE_PATH),
        nextPath: parseProjectRelativePath(nextPath),
        expectedWorkspaceRevision: parseWorkspaceRevision('rev-2'),
      }),
    ).resolves.toMatchObject({ path: FILE_PATH, nextPath, workspaceRevision: 'rev-3' });

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/entries/rename');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('access-token');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        path: FILE_PATH,
        nextPath,
        expectedWorkspaceRevision: 'rev-2',
      }),
    );
  });

  it('DELETEs an entry with URLSearchParams path and revision JSON body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ path: FILE_PATH, workspaceRevision: 'rev-4' }),
    );
    installClient(fetchImpl);

    await expect(
      deleteEntry(PROJECT_ID, parseProjectRelativePath(FILE_PATH), {
        expectedWorkspaceRevision: parseWorkspaceRevision('rev-3'),
      }),
    ).resolves.toEqual({ path: FILE_PATH, workspaceRevision: 'rev-4' });

    const requestUrl = callUrl(fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('DELETE');
    expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/entries');
    expect(requestUrl.searchParams.get('path')).toBe(FILE_PATH);
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('access-token');
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain('access-token');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ expectedWorkspaceRevision: 'rev-3' }),
    );
  });

  it('passes AbortSignal unchanged through saveFileContent', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ file: monacoMetadata, workspaceRevision: 'rev-2' }),
    );
    installClient(fetchImpl);

    await saveFileContent(
      PROJECT_ID,
      parseProjectRelativePath(FILE_PATH),
      {
        content: 'class App {}',
        expectedWorkspaceRevision: parseWorkspaceRevision('rev-1'),
      },
      controller.signal,
    );

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
