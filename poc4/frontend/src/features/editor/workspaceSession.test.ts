import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseProjectRelativePath } from '../files/pathPolicy';
import {
  hasDirtySelfOrDescendant,
  useWorkspaceSession,
  workspaceSessionStore,
} from './workspaceSession';

const pom = parseProjectRelativePath('pom.xml');
const readme = parseProjectRelativePath('README.md');
const appJava = parseProjectRelativePath('src/main/java/demo/App.java');
const src = parseProjectRelativePath('src');
const srcMain = parseProjectRelativePath('src/main');
const srcMainJava = parseProjectRelativePath('src/main/java');
const docs = parseProjectRelativePath('docs');

function view() {
  const state = useWorkspaceSession.getState();
  return {
    projectId: state.projectId,
    expandedPaths: [...state.expandedPaths].sort(),
    selectedPath: state.selectedPath,
    openPaths: state.openPaths,
    activePath: state.activePath,
    dirtyPaths: [...state.dirtyPaths].sort(),
  };
}

beforeEach(() => {
  useWorkspaceSession.getState().reset();
});

afterEach(() => {
  useWorkspaceSession.getState().reset();
});

describe('workspaceSession', () => {
  it('starts empty without writing web storage', () => {
    const localSet = vi.spyOn(window.localStorage, 'setItem');
    const sessionSet = vi.spyOn(window.sessionStorage, 'setItem');

    expect(view()).toEqual({
      projectId: null,
      expandedPaths: [],
      selectedPath: null,
      openPaths: [],
      activePath: null,
      dirtyPaths: [],
    });
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it('openFile activates an existing tab instead of duplicating it', () => {
    const store = useWorkspaceSession.getState();
    const beforeOpen = store.openPaths;
    store.openFile(pom);
    store.openFile(readme);
    const afterTwo = useWorkspaceSession.getState().openPaths;
    expect(afterTwo).not.toBe(beforeOpen);

    store.openFile(pom);

    expect(view()).toMatchObject({
      openPaths: [pom, readme],
      activePath: pom,
    });
    expect(useWorkspaceSession.getState().openPaths).toBe(afterTwo);
  });

  it('closeFile selects the next tab to the right, else previous, else null', () => {
    const store = useWorkspaceSession.getState();
    store.openFile(pom);
    store.openFile(readme);
    store.openFile(appJava);
    expect(view()).toMatchObject({ openPaths: [pom, readme, appJava], activePath: appJava });

    store.closeFile(appJava);
    expect(view()).toMatchObject({ openPaths: [pom, readme], activePath: readme });

    useWorkspaceSession.getState().openFile(appJava);
    useWorkspaceSession.getState().openFile(readme);
    expect(view()).toMatchObject({ openPaths: [pom, readme, appJava], activePath: readme });
    useWorkspaceSession.getState().closeFile(readme);
    expect(view()).toMatchObject({ openPaths: [pom, appJava], activePath: appJava });

    useWorkspaceSession.getState().openFile(pom);
    useWorkspaceSession.getState().closeFile(pom);
    expect(view()).toMatchObject({ openPaths: [appJava], activePath: appJava });

    useWorkspaceSession.getState().closeFile(appJava);
    expect(view()).toMatchObject({ openPaths: [], activePath: null });
  });

  it('closeFile of a non-active tab keeps the current active path', () => {
    const store = useWorkspaceSession.getState();
    store.openFile(pom);
    store.openFile(readme);
    store.closeFile(pom);

    expect(view()).toMatchObject({ openPaths: [readme], activePath: readme });
  });

  it('toggleDirectory expands immutably and collapse removes descendant expanded paths', () => {
    const store = useWorkspaceSession.getState();
    store.toggleDirectory(src);
    const afterSrc = useWorkspaceSession.getState().expandedPaths;
    expect(afterSrc).not.toBe(store.expandedPaths);
    expect(afterSrc.has(src)).toBe(true);
    expect(store.expandedPaths.has(src)).toBe(false);

    useWorkspaceSession.getState().toggleDirectory(srcMain);
    useWorkspaceSession.getState().toggleDirectory(srcMainJava);
    useWorkspaceSession.getState().toggleDirectory(docs);
    const beforeCollapse = useWorkspaceSession.getState().expandedPaths;
    expect([...beforeCollapse].sort()).toEqual([docs, src, srcMain, srcMainJava]);

    useWorkspaceSession.getState().toggleDirectory(src);
    const afterCollapse = useWorkspaceSession.getState().expandedPaths;
    expect(afterCollapse).not.toBe(beforeCollapse);
    expect([...afterCollapse].sort()).toEqual([docs]);
    expect(beforeCollapse.has(src)).toBe(true);
    expect(beforeCollapse.has(srcMainJava)).toBe(true);
  });

  it('activateProject preserves same-id state and resets on a different id', () => {
    const store = useWorkspaceSession.getState();
    store.activateProject('prj-alice-notebook');
    store.toggleDirectory(src);
    store.selectPath(appJava);
    store.openFile(pom);
    const snapshot = view();
    const expanded = useWorkspaceSession.getState().expandedPaths;
    const openPaths = useWorkspaceSession.getState().openPaths;

    useWorkspaceSession.getState().activateProject('prj-alice-notebook');
    expect(view()).toEqual(snapshot);
    expect(useWorkspaceSession.getState().expandedPaths).toBe(expanded);
    expect(useWorkspaceSession.getState().openPaths).toBe(openPaths);

    useWorkspaceSession.getState().activateProject('prj-bob-lab');
    expect(view()).toEqual({
      projectId: 'prj-bob-lab',
      expandedPaths: [],
      selectedPath: null,
      openPaths: [],
      activePath: null,
      dirtyPaths: [],
    });
    expect(useWorkspaceSession.getState().expandedPaths).not.toBe(expanded);
    expect(useWorkspaceSession.getState().openPaths).not.toBe(openPaths);
  });

  it('reorderTabs moves paths without mutating the previous array', () => {
    const store = useWorkspaceSession.getState();
    store.openFile(pom);
    store.openFile(readme);
    store.openFile(appJava);
    const before = useWorkspaceSession.getState().openPaths;

    useWorkspaceSession.getState().reorderTabs(0, 2);

    const after = useWorkspaceSession.getState().openPaths;
    expect(after).toEqual([readme, appJava, pom]);
    expect(after).not.toBe(before);
    expect(before).toEqual([pom, readme, appJava]);
    expect(useWorkspaceSession.getState().activePath).toBe(appJava);
  });

  it('selectPath and reset restore the initial empty session', () => {
    const store = useWorkspaceSession.getState();
    store.activateProject('prj-alice-notebook');
    store.selectPath(pom);
    store.openFile(readme);
    expect(useWorkspaceSession.getState().selectedPath).toBe(pom);

    store.selectPath(null);
    expect(useWorkspaceSession.getState().selectedPath).toBeNull();

    useWorkspaceSession.getState().reset();
    expect(view()).toEqual({
      projectId: null,
      expandedPaths: [],
      selectedPath: null,
      openPaths: [],
      activePath: null,
      dirtyPaths: [],
    });
    expect(useWorkspaceSession.getInitialState().projectId).toBeNull();
    expect(useWorkspaceSession.getInitialState().openPaths).toEqual([]);
    expect(useWorkspaceSession.getInitialState().dirtyPaths.size).toBe(0);
  });

  it('exposes runtime getState through workspaceSessionStore only', () => {
    workspaceSessionStore.getState().activateProject('prj-bob-lab');
    expect(workspaceSessionStore.getState()).toBe(useWorkspaceSession.getState());
    expect(workspaceSessionStore.getState().projectId).toBe('prj-bob-lab');
    expect(workspaceSessionStore).not.toHaveProperty('persist');
    expect(Object.keys(workspaceSessionStore)).toEqual(['getState']);
  });
});

describe('workspaceSession dirty and path lifecycle', () => {
  const srcA = parseProjectRelativePath('src/a');
  const srcAFoo = parseProjectRelativePath('src/a/foo.ts');
  const srcAb = parseProjectRelativePath('src/ab');
  const srcB = parseProjectRelativePath('src/b');
  const srcBFoo = parseProjectRelativePath('src/b/foo.ts');

  it('setDirty updates an immutable set and never stores content or revision', () => {
    const store = useWorkspaceSession.getState();
    store.activateProject('prj-alice-notebook');
    const before = store.dirtyPaths;

    store.setDirty(pom, true);
    const afterAdd = useWorkspaceSession.getState().dirtyPaths;
    expect(afterAdd).not.toBe(before);
    expect([...afterAdd]).toEqual([pom]);
    expect(before.has(pom)).toBe(false);

    useWorkspaceSession.getState().setDirty(pom, true);
    expect(useWorkspaceSession.getState().dirtyPaths).toBe(afterAdd);

    useWorkspaceSession.getState().setDirty(readme, true);
    const afterSecond = useWorkspaceSession.getState().dirtyPaths;
    expect(afterSecond).not.toBe(afterAdd);
    expect([...afterSecond].sort()).toEqual([readme, pom].sort());

    useWorkspaceSession.getState().setDirty(pom, false);
    const afterRemove = useWorkspaceSession.getState().dirtyPaths;
    expect(afterRemove).not.toBe(afterSecond);
    expect([...afterRemove]).toEqual([readme]);
    expect(afterSecond.has(pom)).toBe(true);

    const state = useWorkspaceSession.getState();
    expect(state).not.toHaveProperty('content');
    expect(state).not.toHaveProperty('workspaceRevision');
    expect(Object.values(state)).not.toContain('file body');
  });

  it('activateProject keeps same-id dirty paths and resets them through getInitialState', () => {
    const store = useWorkspaceSession.getState();
    store.activateProject('prj-alice-notebook');
    store.setDirty(pom, true);
    const dirty = useWorkspaceSession.getState().dirtyPaths;

    useWorkspaceSession.getState().activateProject('prj-alice-notebook');
    expect(useWorkspaceSession.getState().dirtyPaths).toBe(dirty);
    expect([...useWorkspaceSession.getState().dirtyPaths]).toEqual([pom]);

    useWorkspaceSession.getState().activateProject('prj-bob-lab');
    expect(view()).toMatchObject({
      projectId: 'prj-bob-lab',
      dirtyPaths: [],
    });
    expect(useWorkspaceSession.getState().dirtyPaths).not.toBe(dirty);
  });

  it('remapPath rewrites selected, active, open, expanded and dirty descendants only', () => {
    const store = useWorkspaceSession.getState();
    store.activateProject('prj-alice-notebook');
    store.toggleDirectory(src);
    store.toggleDirectory(srcA);
    store.toggleDirectory(srcAb);
    store.openFile(srcAFoo);
    store.openFile(srcAb);
    store.openFile(pom);
    store.selectPath(srcAFoo);
    store.setDirty(srcAFoo, true);
    store.setDirty(srcAb, true);
    const beforeOpen = useWorkspaceSession.getState().openPaths;
    const beforeExpanded = useWorkspaceSession.getState().expandedPaths;
    const beforeDirty = useWorkspaceSession.getState().dirtyPaths;

    useWorkspaceSession.getState().remapPath(srcA, srcB);

    expect(useWorkspaceSession.getState().openPaths).not.toBe(beforeOpen);
    expect(useWorkspaceSession.getState().expandedPaths).not.toBe(beforeExpanded);
    expect(useWorkspaceSession.getState().dirtyPaths).not.toBe(beforeDirty);
    expect(view()).toMatchObject({
      selectedPath: srcBFoo,
      activePath: pom,
      openPaths: [srcBFoo, srcAb, pom],
    });
    expect([...useWorkspaceSession.getState().expandedPaths].sort()).toEqual(
      [src, srcB, srcAb].sort(),
    );
    expect([...useWorkspaceSession.getState().dirtyPaths].sort()).toEqual(
      [srcBFoo, srcAb].sort(),
    );
    expect(beforeOpen).toEqual([srcAFoo, srcAb, pom]);
    expect(beforeExpanded.has(srcA)).toBe(true);
    expect(beforeDirty.has(srcAFoo)).toBe(true);
  });

  it('removePathAndDescendants clears matching selected, active, open, expanded and dirty paths', () => {
    const store = useWorkspaceSession.getState();
    store.activateProject('prj-alice-notebook');
    store.toggleDirectory(src);
    store.toggleDirectory(srcA);
    store.toggleDirectory(srcAb);
    store.openFile(pom);
    store.openFile(srcAFoo);
    store.openFile(srcAb);
    store.openFile(srcAFoo);
    store.selectPath(srcAFoo);
    store.setDirty(srcAFoo, true);
    store.setDirty(srcAb, true);
    store.setDirty(pom, true);

    useWorkspaceSession.getState().removePathAndDescendants(srcA);

    expect(view()).toMatchObject({
      selectedPath: null,
      activePath: srcAb,
      openPaths: [pom, srcAb],
      dirtyPaths: [pom, srcAb].sort(),
    });
    expect([...useWorkspaceSession.getState().expandedPaths].sort()).toEqual(
      [src, srcAb].sort(),
    );
  });

  it('hasDirtySelfOrDescendant matches the target and descendants, not prefix siblings', () => {
    const dirty = new Set([srcAFoo, srcAb]);
    expect(hasDirtySelfOrDescendant(dirty, srcAFoo)).toBe(true);
    expect(hasDirtySelfOrDescendant(dirty, srcA)).toBe(true);
    expect(hasDirtySelfOrDescendant(dirty, srcAb)).toBe(true);
    expect(hasDirtySelfOrDescendant(dirty, src)).toBe(true);
    expect(hasDirtySelfOrDescendant(dirty, pom)).toBe(false);
    expect(hasDirtySelfOrDescendant(new Set([srcAb]), srcA)).toBe(false);
    expect(hasDirtySelfOrDescendant(new Set([srcA]), srcAb)).toBe(false);
  });
});
