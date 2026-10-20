import { describe, expect, it } from 'vitest';
import { parseRunErrorLocations, resolveRunErrorPath } from './runErrorLocator';

describe('run error locations', () => {
  it('parses Python, Java, Maven and absolute Windows/Unix paths', () => {
    const locations = parseRunErrorLocations([
      '  File "/workspace/app/main.py", line 12, in main',
      '  at demo.App.main(App.java:24)',
      '[ERROR] /workspace/src/App.java:[17,9] compile failure',
      'C:\\work\\app\\main.py:18:4 failure',
      '/workspace/src/index.ts:7:2 error',
    ].join('\n'));
    expect(locations).toEqual([
      { path: 'workspace/app/main.py', line: 12, source: 'python' },
      { path: 'App.java', line: 24, source: 'java' },
      { path: 'workspace/src/App.java', line: 17, column: 9, source: 'java' },
      { path: 'C:/work/app/main.py', line: 18, column: 4, source: 'generic' },
      { path: 'workspace/src/index.ts', line: 7, column: 2, source: 'generic' },
    ]);
  });
  it('rejects ambiguous or unrelated qualified paths and resolves exact suffixes', () => {
    const paths = ['src/App.java', 'tests/App.java', 'main.py'];
    expect(resolveRunErrorPath({ path: 'App.java', line: 1, source: 'java' }, paths)).toBeNull();
    expect(resolveRunErrorPath({ path: '/workspace/src/App.java', line: 1, source: 'java' }, paths)).toBe('src/App.java');
    expect(resolveRunErrorPath({ path: '/dependency/main.py', line: 1, source: 'python' }, ['app/main.py'])).toBeNull();
  });
  it('deduplicates repeated frames, bounds locations and rejects invalid coordinates', () => {
    const log = ['main.py:0:1', 'main.py:1:0', 'main.py:2:3', 'main.py:2:3', ...Array.from({ length: 130 }, (_, index) => `src/file-${index}.py:4:5`)];
    const locations = parseRunErrorLocations(log.join('\n'));
    expect(locations.length).toBeLessThanOrEqual(100);
    expect(locations.filter((entry) => entry.path === 'main.py')).toEqual([{ path: 'main.py', line: 2, column: 3, source: 'generic' }]);
  });
});
