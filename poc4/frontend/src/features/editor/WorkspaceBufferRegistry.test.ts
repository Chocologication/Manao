import * as monaco from 'monaco-editor';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRelativePath } from '../../contracts/file';
import { parseProjectRelativePath } from '../files/pathPolicy';
import { disposeAllProjectModels, toProjectModelUri } from '../../lib/projectMonacoModels';
import type { WorkspaceBuffer } from './editorTypes';
import { WorkspaceBufferRegistry } from './WorkspaceBufferRegistry';

const ALICE = 'prj-alice-notebook';
const BOB = 'prj-bob-lab';
const POM = parseProjectRelativePath('pom.xml');
const README = parseProjectRelativePath('README.md');
const SRC_A = parseProjectRelativePath('src/a');
const SRC_A_FOO = parseProjectRelativePath('src/a/foo.ts');
const SRC_AB = parseProjectRelativePath('src/ab');
const SRC_B = parseProjectRelativePath('src/b');
const SRC_B_FOO = parseProjectRelativePath('src/b/foo.ts');

function asPlain(buffer: WorkspaceBuffer): WorkspaceBuffer & { replace(content: string): void } {
  expect(buffer.kind).toBe('plain-text');
  return buffer as WorkspaceBuffer & { replace(content: string): void };
}

function editMonaco(model: monaco.editor.ITextModel, text: string): void {
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text }],
    () => null,
  );
}

function createRegistry() {
  const onDirtyChange = vi.fn();
  const registry = new WorkspaceBufferRegistry(onDirtyChange);
  return { registry, onDirtyChange };
}

function registerPlain(
  registry: WorkspaceBufferRegistry,
  projectId: string,
  path: ProjectRelativePath,
  content: string,
): WorkspaceBuffer {
  return registry.register({
    projectId,
    path,
    kind: 'plain-text',
    content,
  });
}

function registerMonaco(
  registry: WorkspaceBufferRegistry,
  projectId: string,
  path: ProjectRelativePath,
  content: string,
): { buffer: WorkspaceBuffer; model: monaco.editor.ITextModel } {
  const model = monaco.editor.createModel(
    content,
    'plaintext',
    toProjectModelUri(projectId, path),
  );
  const buffer = registry.register({
    projectId,
    path,
    kind: 'monaco',
    model,
  });
  return { buffer, model };
}

afterEach(() => {
  disposeAllProjectModels();
});

describe('WorkspaceBufferRegistry source boundary', () => {
  it('does not import the Zustand session store or monaco-editor', () => {
    const source = readFileSync('src/features/editor/WorkspaceBufferRegistry.ts', 'utf8');
    expect(source).not.toMatch(/workspaceSession/);
    expect(source).not.toMatch(/from ['"]monaco-editor['"]/);
    expect(source).not.toMatch(/from ['"]monaco-editor\//);
    expect(source).not.toMatch(/from ['"]zustand['"]/);
  });
});

describe('WorkspaceBufferRegistry register', () => {
  it('registers a buffer once and returns it from get', () => {
    const { registry } = createRegistry();
    const buffer = registerPlain(registry, ALICE, POM, '<project />');

    expect(buffer.projectId).toBe(ALICE);
    expect(buffer.path).toBe(POM);
    expect(buffer.kind).toBe('plain-text');
    expect(buffer.isDirty()).toBe(false);
    expect(registry.get(ALICE, POM)).toBe(buffer);
  });

  it('rejects a duplicate register for the same project and path', () => {
    const { registry } = createRegistry();
    registerPlain(registry, ALICE, POM, '<project />');

    expect(() => registerPlain(registry, ALICE, POM, '<other />')).toThrow(
      'Workspace buffer already registered',
    );
    expect(registry.get(ALICE, POM)?.snapshot().content).toBe('<project />');
  });

  it('keeps Alice and Bob buffers with the same relative path isolated', () => {
    const { registry, onDirtyChange } = createRegistry();
    const alice = registerPlain(registry, ALICE, POM, 'alice');
    const bob = registerPlain(registry, BOB, POM, 'bob');

    expect(alice).not.toBe(bob);
    expect(registry.get(ALICE, POM)).toBe(alice);
    expect(registry.get(BOB, POM)).toBe(bob);

    asPlain(alice).replace('alice-edit');

    expect(alice.isDirty()).toBe(true);
    expect(bob.isDirty()).toBe(false);
    expect(bob.snapshot().content).toBe('bob');
    expect(onDirtyChange).toHaveBeenCalledWith(ALICE, POM, true);
    expect(onDirtyChange).not.toHaveBeenCalledWith(BOB, POM, true);
  });
});

describe('WorkspaceBufferRegistry snapshot and subscribe', () => {
  it('returns a fresh immutable snapshot object', () => {
    const { registry } = createRegistry();
    const buffer = registerPlain(registry, ALICE, README, '# notes');
    const first = buffer.snapshot();
    const second = buffer.snapshot();

    expect(first).toEqual({ content: '# notes', version: 0 });
    expect(first).not.toBe(second);
    expect(second).toEqual(first);

    first.content = 'mutated';
    first.version = 99;
    expect(buffer.snapshot()).toEqual({ content: '# notes', version: 0 });
  });

  it('notifies listeners until they unsubscribe', () => {
    const { registry } = createRegistry();
    const buffer = registerPlain(registry, ALICE, README, 'one');
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);

    asPlain(buffer).replace('two');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    asPlain(buffer).replace('three');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspaceBufferRegistry dirty lifecycle', () => {
  it('marks a monaco buffer dirty on edit and clean after undo to baseline', () => {
    const { registry, onDirtyChange } = createRegistry();
    const { buffer, model } = registerMonaco(registry, ALICE, POM, 'hello');
    expect(buffer.kind).toBe('monaco');
    expect(buffer.isDirty()).toBe(false);

    editMonaco(model, 'hello!');
    expect(buffer.isDirty()).toBe(true);
    expect(buffer.snapshot().content).toBe('hello!');
    expect(onDirtyChange).toHaveBeenCalledWith(ALICE, POM, true);

    const undone = model.undo();
    if (undone !== undefined) {
      return Promise.resolve(undone).then(() => {
        expect(buffer.snapshot().content).toBe('hello');
        expect(buffer.isDirty()).toBe(false);
        expect(onDirtyChange).toHaveBeenCalledWith(ALICE, POM, false);
      });
    }

    expect(buffer.snapshot().content).toBe('hello');
    expect(buffer.isDirty()).toBe(false);
    expect(onDirtyChange).toHaveBeenCalledWith(ALICE, POM, false);
  });

  it('keeps plain-text dirty after an edit that returns to identical text', () => {
    const { registry, onDirtyChange } = createRegistry();
    const buffer = registerPlain(registry, ALICE, README, 'hello');

    asPlain(buffer).replace('hello!');
    expect(buffer.isDirty()).toBe(true);
    asPlain(buffer).replace('hello');
    expect(buffer.snapshot().content).toBe('hello');
    expect(buffer.isDirty()).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(ALICE, README, true);
  });

  it('clears dirty when markSaved receives the exact request snapshot', () => {
    const { registry, onDirtyChange } = createRegistry();
    const buffer = registerPlain(registry, ALICE, README, 'base');
    asPlain(buffer).replace('saved');
    const request = buffer.snapshot();

    buffer.markSaved(request);

    expect(buffer.isDirty()).toBe(false);
    expect(buffer.snapshot()).toEqual(request);
    expect(onDirtyChange).toHaveBeenLastCalledWith(ALICE, README, false);
  });

  it('stays dirty when markSaved receives an earlier request after a later edit', () => {
    const { registry } = createRegistry();
    const buffer = registerPlain(registry, ALICE, README, 'base');
    asPlain(buffer).replace('saved');
    const request = buffer.snapshot();
    asPlain(buffer).replace('later');

    buffer.markSaved(request);

    expect(buffer.isDirty()).toBe(true);
    expect(buffer.snapshot().content).toBe('later');
    expect(buffer.snapshot().version).toBeGreaterThan(request.version);
  });

  it('discards back to the last saved snapshot', () => {
    const { registry } = createRegistry();
    const buffer = registerPlain(registry, ALICE, README, 'base');
    asPlain(buffer).replace('saved');
    const request = buffer.snapshot();
    asPlain(buffer).replace('later');
    buffer.markSaved(request);

    buffer.discard();

    expect(buffer.snapshot().content).toBe('saved');
    expect(buffer.isDirty()).toBe(false);
  });
});

function throwingMonacoModel(content: string) {
  return {
    getValue: () => content,
    setValue: () => {},
    getAlternativeVersionId: () => 1,
    onDidChangeContent: () => ({ dispose() {} }),
    dispose() {
      throw new Error('dispose failed');
    },
  };
}

describe('WorkspaceBufferRegistry remap and dispose', () => {
  it('remaps by disposing old-path adapters and leaves the next path empty', () => {
    const { registry } = createRegistry();
    const fileA = registerPlain(registry, ALICE, SRC_A, 'a');
    registerPlain(registry, ALICE, SRC_A_FOO, 'foo');
    const sibling = registerPlain(registry, ALICE, SRC_AB, 'ab');
    const bob = registerPlain(registry, BOB, SRC_A, 'bob-a');

    registry.remap(ALICE, SRC_A, SRC_B);

    expect(registry.get(ALICE, SRC_A)).toBeUndefined();
    expect(registry.get(ALICE, SRC_A_FOO)).toBeUndefined();
    expect(registry.get(ALICE, SRC_B)).toBeUndefined();
    expect(registry.get(ALICE, SRC_B_FOO)).toBeUndefined();
    expect(registry.get(ALICE, SRC_AB)).toBe(sibling);
    expect(registry.get(BOB, SRC_A)).toBe(bob);
    expect(() => fileA.snapshot()).not.toThrow();
    expect(fileA.snapshot().content).toBe('a');
  });

  it('does not leave a live monaco adapter after remap', () => {
    const { registry } = createRegistry();
    const { buffer, model } = registerMonaco(registry, ALICE, POM, 'hello');
    editMonaco(model, 'hello!');

    registry.remap(ALICE, POM, README);

    expect(registry.get(ALICE, POM)).toBeUndefined();
    expect(registry.get(ALICE, README)).toBeUndefined();
    expect(monaco.editor.getModel(model.uri)).toBeNull();
    expect(() => buffer.snapshot()).not.toThrow();
    expect(buffer.snapshot().content).toBe('hello!');
    expect(buffer.isDirty()).toBe(false);
  });

  it('removes a path and descendants and treats dispose as idempotent', () => {
    const { registry, onDirtyChange } = createRegistry();
    const fileA = registerPlain(registry, ALICE, SRC_A, 'a');
    registerPlain(registry, ALICE, SRC_A_FOO, 'foo');
    const sibling = registerPlain(registry, ALICE, SRC_AB, 'ab');
    const bob = registerPlain(registry, BOB, SRC_A, 'bob-a');
    asPlain(fileA).replace('dirty-a');

    registry.remove(ALICE, SRC_A);
    registry.remove(ALICE, SRC_A);
    fileA.dispose();
    fileA.dispose();

    expect(registry.get(ALICE, SRC_A)).toBeUndefined();
    expect(registry.get(ALICE, SRC_A_FOO)).toBeUndefined();
    expect(registry.get(ALICE, SRC_AB)).toBe(sibling);
    expect(registry.get(BOB, SRC_A)).toBe(bob);
    expect(onDirtyChange).toHaveBeenCalledWith(ALICE, SRC_A, false);
  });

  it('disposeAll clears every project buffer twice without throwing', () => {
    const { registry } = createRegistry();
    const { buffer, model } = registerMonaco(registry, ALICE, POM, 'alice');
    registerPlain(registry, BOB, POM, 'bob');

    registry.disposeAll();
    registry.disposeAll();

    expect(registry.get(ALICE, POM)).toBeUndefined();
    expect(registry.get(BOB, POM)).toBeUndefined();
    expect(monaco.editor.getModel(model.uri)).toBeNull();
    expect(() => buffer.dispose()).not.toThrow();
  });

  it('disposeAll still disposes remaining buffers when one adapter throws', () => {
    const { registry } = createRegistry();
    registry.register({
      projectId: ALICE,
      path: POM,
      kind: 'monaco',
      model: throwingMonacoModel('boom'),
    });
    const { model: survivor } = registerMonaco(registry, BOB, POM, 'keep');

    expect(() => registry.disposeAll()).not.toThrow();
    expect(registry.get(ALICE, POM)).toBeUndefined();
    expect(registry.get(BOB, POM)).toBeUndefined();
    expect(monaco.editor.getModel(survivor.uri)).toBeNull();
  });

  it('disposeProject drops leftover buffers so they cannot refill another session', () => {
    const { registry, onDirtyChange } = createRegistry();
    const alice = registerPlain(registry, ALICE, POM, 'alice');
    const bob = registerPlain(registry, BOB, README, 'bob');
    asPlain(alice).replace('dirty-alice');

    registry.disposeProject(ALICE);
    registry.disposeProject(ALICE);

    expect(registry.get(ALICE, POM)).toBeUndefined();
    expect(registry.get(BOB, README)).toBe(bob);
    expect(onDirtyChange).toHaveBeenCalledWith(ALICE, POM, false);
    onDirtyChange.mockClear();
    asPlain(alice).replace('after-dispose');
    expect(onDirtyChange).not.toHaveBeenCalled();
    expect(bob.isDirty()).toBe(false);
  });
});
