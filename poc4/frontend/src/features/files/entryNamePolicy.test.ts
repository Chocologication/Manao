import { describe, expect, it } from 'vitest';
import { parseProjectDirectoryPath } from './pathPolicy';
import { joinProjectPath, parseEntryBasename } from './entryNamePolicy';

describe('parseEntryBasename', () => {
  it.each(['.gitignore', '.env.local', '你好.java', 'App.java', 'notes (1).md'])(
    'accepts hidden and Unicode basename %s',
    (value) => {
      expect(parseEntryBasename(value)).toBe(value);
    },
  );

  it.each(['', '/', 'src/App.java', 'App\\java', 'dir\\file', '\0', '.\0hidden', '.', '..'])(
    'rejects %s',
    (value) => {
      expect(() => parseEntryBasename(value)).toThrow('Entry name required');
    },
  );
});

describe('joinProjectPath', () => {
  it.each([
    ['', 'App.java', 'App.java'],
    ['', '.gitignore', '.gitignore'],
    ['src', 'App.java', 'src/App.java'],
    ['src/main', '你好.java', 'src/main/你好.java'],
    ['docs', '.hidden', 'docs/.hidden'],
  ] as const)('joins parent %j and basename %j', (parent, basename, expected) => {
    expect(joinProjectPath(parseProjectDirectoryPath(parent), basename)).toBe(expected);
  });

  it.each(['', '/', '..', '.', 'a/b', 'a\\b', '\0'])(
    'does not compose an invalid basename %s',
    (basename) => {
      expect(() => joinProjectPath(parseProjectDirectoryPath('src'), basename)).toThrow(
        'Entry name required',
      );
    },
  );
});
