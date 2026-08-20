import { describe, expect, it } from 'vitest';
import { toModelUri } from './monacoModels';

describe('toModelUri', () => {
  it('creates stable project-relative Monaco URIs', () => {
    expect(toModelUri('pom.xml').toString()).toBe('poc4://workspace/pom.xml');
    expect(toModelUri('src/main/App.java').toString()).toBe(
      'poc4://workspace/src/main/App.java'
    );
  });

  it.each(['', '/etc/passwd', '../secret', 'src/../../secret', 'C:\\repo\\file'])(
    'rejects invalid model path %s',
    (path) => expect(() => toModelUri(path)).toThrow('Project-relative path required')
  );
});
