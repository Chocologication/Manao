import { describe, expect, it } from 'vitest';
import { parseProjectDirectoryPath, parseProjectRelativePath } from './pathPolicy';

describe('parseProjectRelativePath', () => {
  it.each([
    '/etc/passwd',
    '\\server\\share',
    'C:\\repo\\file',
    '../secret',
    'src/../../secret',
    './pom.xml',
    'src//App.java',
    'src\\App.java',
    'src/\0App.java',
  ])('rejects %s', (value) => {
    expect(() => parseProjectRelativePath(value)).toThrow('Project-relative path required');
  });

  it('rejects empty string unless allowRoot is set', () => {
    expect(() => parseProjectRelativePath('')).toThrow('Project-relative path required');
    expect(parseProjectRelativePath('', { allowRoot: true })).toBe('');
  });

  it('accepts dotfiles, nested files, and Unicode names without decoding percent text', () => {
    expect(parseProjectRelativePath('.gitignore')).toBe('.gitignore');
    expect(parseProjectRelativePath('src/main/java/demo/App.java')).toBe(
      'src/main/java/demo/App.java',
    );
    expect(parseProjectRelativePath('src/你好.java')).toBe('src/你好.java');
    expect(parseProjectRelativePath('%2e%2e')).toBe('%2e%2e');
  });

  it('keeps literal %2e%2e through URLSearchParams transport encoding', () => {
    const path = parseProjectRelativePath('%2e%2e');
    const params = new URLSearchParams();
    params.set('path', path);
    expect(params.get('path')).toBe('%2e%2e');
    expect(params.toString()).toBe('path=%252e%252e');
  });
});

describe('parseProjectDirectoryPath', () => {
  it('accepts empty string as the project root directory', () => {
    expect(parseProjectDirectoryPath('')).toBe('');
  });

  it('accepts the same valid relative directories as parseProjectRelativePath', () => {
    expect(parseProjectDirectoryPath('src/main')).toBe('src/main');
    expect(parseProjectDirectoryPath('.github')).toBe('.github');
  });

  it.each(['/etc', '../secret', 'src\\main', 'src//main'])(
    'rejects %s',
    (value) => {
      expect(() => parseProjectDirectoryPath(value)).toThrow('Project-relative path required');
    },
  );
});
