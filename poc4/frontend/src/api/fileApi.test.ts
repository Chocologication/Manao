import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileContentResponse, FileMetadata, FileTreeResponse } from '../contracts/file';
import {
  parseFileContentResponse,
  parseFileMetadata,
  parseFileTreeResponse,
} from '../contracts/file';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../features/files/pathPolicy';
import { downloadFileBlob, getFileContent, getFileMetadata, listDirectory } from './fileApi';
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
  workspaceRevision: 'rev-1',
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
    };

    expect(() => parseFileTreeResponse(payload, directory)).toThrow('Invalid file response');
  });

  it.each([
    [
      'duplicate sibling paths',
      {
        directory: 'src',
        entries: [srcTree.entries[0], srcTree.entries[0]],
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
