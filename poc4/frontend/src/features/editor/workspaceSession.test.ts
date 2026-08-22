import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseProjectRelativePath } from '../files/pathPolicy';
import { useWorkspaceSession, workspaceSessionStore } from './workspaceSession';

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
    });
    expect(useWorkspaceSession.getInitialState().projectId).toBeNull();
    expect(useWorkspaceSession.getInitialState().openPaths).toEqual([]);
  });

  it('exposes runtime getState through workspaceSessionStore only', () => {
    workspaceSessionStore.getState().activateProject('prj-bob-lab');
    expect(workspaceSessionStore.getState()).toBe(useWorkspaceSession.getState());
    expect(workspaceSessionStore.getState().projectId).toBe('prj-bob-lab');
    expect(workspaceSessionStore).not.toHaveProperty('persist');
    expect(Object.keys(workspaceSessionStore)).toEqual(['getState']);
  });
});
