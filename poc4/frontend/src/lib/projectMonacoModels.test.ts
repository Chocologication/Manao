import * as monaco from 'monaco-editor';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectRelativePath } from '../contracts/file';
import { parseProjectRelativePath } from '../features/files/pathPolicy';
import {
  disposeAllProjectModels,
  disposeProjectModel,
  disposeProjectModels,
  toProjectModelUri,
} from './projectMonacoModels';

const FILE = parseProjectRelativePath('src/main/java/demo/App.java');

afterEach(() => {
  disposeAllProjectModels();
});

describe('toProjectModelUri', () => {
  it('builds poc4 workspace URIs with a separately encoded project id segment', () => {
    const uri = toProjectModelUri('prj-alice-notebook', FILE);
    expect(uri.scheme).toBe('poc4');
    expect(uri.authority).toBe('workspace');
    expect(uri.query).toBe('');
    expect(uri.fragment).toBe('');
    expect(uri.path).toBe('/prj-alice-notebook/src/main/java/demo/App.java');
  });

  it('keeps two projects with the same relative path on distinct models', () => {
    const aliceUri = toProjectModelUri('prj-alice-notebook', FILE);
    const bobUri = toProjectModelUri('prj-bob-lab', FILE);
    expect(aliceUri.toString()).not.toBe(bobUri.toString());

    const alice = monaco.editor.createModel('alice', 'java', aliceUri);
    const bob = monaco.editor.createModel('bob', 'java', bobUri);
    expect(alice).not.toBe(bob);
    expect(monaco.editor.getModel(aliceUri)).toBe(alice);
    expect(monaco.editor.getModel(bobUri)).toBe(bob);
    expect(alice.getValue()).toBe('alice');
    expect(bob.getValue()).toBe('bob');
  });

  it('does not let opaque ids containing /, ? or # change URI structure', () => {
    const projectId = 'alice/prj?x#y';
    const uri = toProjectModelUri(projectId, FILE);
    const encodedId = encodeURIComponent(projectId);

    expect(uri.scheme).toBe('poc4');
    expect(uri.authority).toBe('workspace');
    expect(uri.query).toBe('');
    expect(uri.fragment).toBe('');
    expect(uri.path.split('/').filter(Boolean)[0]).toBe(encodedId);
    expect(uri.path).toBe(`/${encodedId}/${FILE}`);
    expect(uri.toString()).toContain(encodeURIComponent(encodedId));
    expect(uri.toString()).not.toMatch(/\?x/);
    expect(uri.toString()).not.toMatch(/#y/);
    expect(uri.toString().startsWith('poc4://workspace/')).toBe(true);
  });

  it.each(['', '/etc/passwd', '../secret', 'src/../../secret', 'C:\\repo\\file'])(
    'rejects invalid model path %s',
    (path) => {
      expect(() => toProjectModelUri('prj-alice-notebook', path as ProjectRelativePath)).toThrow(
        'Project-relative path required',
      );
    },
  );
});

describe('project Monaco model dispose', () => {
  it('disposeProjectModel removes only that project file model', () => {
    const aliceUri = toProjectModelUri('prj-alice-notebook', FILE);
    const bobUri = toProjectModelUri('prj-bob-lab', FILE);
    monaco.editor.createModel('alice', 'java', aliceUri);
    monaco.editor.createModel('bob', 'java', bobUri);

    disposeProjectModel('prj-alice-notebook', FILE);

    expect(monaco.editor.getModel(aliceUri)).toBeNull();
    expect(monaco.editor.getModel(bobUri)?.getValue()).toBe('bob');
  });

  it('disposeProjectModels removes every model for one project id', () => {
    const aliceApp = toProjectModelUri('prj-alice-notebook', FILE);
    const alicePom = toProjectModelUri('prj-alice-notebook', parseProjectRelativePath('pom.xml'));
    const bobApp = toProjectModelUri('prj-bob-lab', FILE);
    monaco.editor.createModel('alice-app', 'java', aliceApp);
    monaco.editor.createModel('alice-pom', 'xml', alicePom);
    monaco.editor.createModel('bob', 'java', bobApp);

    disposeProjectModels('prj-alice-notebook');

    expect(monaco.editor.getModel(aliceApp)).toBeNull();
    expect(monaco.editor.getModel(alicePom)).toBeNull();
    expect(monaco.editor.getModel(bobApp)?.getValue()).toBe('bob');
  });

  it('disposeAllProjectModels clears every project-scoped model', () => {
    monaco.editor.createModel('a', 'java', toProjectModelUri('prj-alice-notebook', FILE));
    monaco.editor.createModel('b', 'java', toProjectModelUri('prj-bob-lab', FILE));

    disposeAllProjectModels();

    const remaining = monaco.editor
      .getModels()
      .filter((model) => model.uri.scheme === 'poc4' && model.uri.authority === 'workspace');
    expect(remaining).toEqual([]);
  });
});
