import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router';
import type { ProjectRelativePath } from '../../contracts/file';

export const DIALOG_TITLE = 'Unsaved changes';
export const CLOSE_TAB_MESSAGE = 'This file has unsaved changes.';
export const LEAVE_MESSAGE = 'You have unsaved changes.';
export const REMAINING_CHANGES_MESSAGE = 'This file still has unsaved changes.';
export const SAVE_AND_CLOSE_LABEL = 'Save and close';
export const DISCARD_LABEL = 'Discard';
export const CANCEL_LABEL = 'Cancel';
export const DISCARD_AND_LEAVE_LABEL = 'Discard and leave';

export type UnsavedGuardAction =
  | { type: 'close-tab'; path: ProjectRelativePath }
  | { type: 'leave-workbench' }
  | { type: 'logout' };

export type UnsavedDialogMode = 'close-tab' | 'leave';

export type GuardConsequences = {
  route: 'unchanged' | 'leave-workbench' | 'login';
  auth: 'unchanged' | 'logout' | 'unauthorized';
  tab: 'unchanged' | 'close-captured' | 'keep-open';
  model: 'unchanged' | 'dispose-after-switch' | 'keep';
  buffer: 'unchanged' | 'remove' | 'discard-then-remove' | 'keep-dirty' | 'discard-all-dirty';
  dialog: 'none' | 'open-close-tab' | 'open-leave' | 'keep-open' | 'close';
};

export type GuardDecision = {
  kind: 'proceed' | 'prompt' | 'dismiss' | 'keep-dialog';
  action?: UnsavedGuardAction;
  mode?: UnsavedDialogMode;
  message?: string;
  consequences: GuardConsequences;
};

export type UnsavedDialogState =
  | { open: false }
  | {
      open: true;
      mode: UnsavedDialogMode;
      action: UnsavedGuardAction;
      message: string;
    };

const KEEP_IN_PLACE: GuardConsequences = {
  route: 'unchanged',
  auth: 'unchanged',
  tab: 'keep-open',
  model: 'keep',
  buffer: 'keep-dirty',
  dialog: 'open-close-tab',
};

export function capturedClosePath(action: UnsavedGuardAction | undefined): ProjectRelativePath | null {
  if (action === undefined || action.type !== 'close-tab') {
    return null;
  }
  return action.path;
}

export function requestCloseTab(
  path: ProjectRelativePath,
  dirtyPaths: ReadonlySet<ProjectRelativePath>,
): GuardDecision {
  if (!dirtyPaths.has(path)) {
    return {
      kind: 'proceed',
      action: { type: 'close-tab', path },
      consequences: {
        route: 'unchanged',
        auth: 'unchanged',
        tab: 'close-captured',
        model: 'dispose-after-switch',
        buffer: 'remove',
        dialog: 'none',
      },
    };
  }
  return {
    kind: 'prompt',
    mode: 'close-tab',
    action: { type: 'close-tab', path },
    message: CLOSE_TAB_MESSAGE,
    consequences: KEEP_IN_PLACE,
  };
}

export function applySaveAndCloseResult(options: {
  capturedPath: ProjectRelativePath;
  saveSucceeded: boolean;
  bufferStillDirty: boolean;
  saveErrorMessage?: string;
}): GuardDecision {
  const action: UnsavedGuardAction = { type: 'close-tab', path: options.capturedPath };
  if (!options.saveSucceeded) {
    return {
      kind: 'keep-dialog',
      action,
      mode: 'close-tab',
      message: options.saveErrorMessage ?? 'Unable to save file',
      consequences: {
        route: 'unchanged',
        auth: 'unchanged',
        tab: 'keep-open',
        model: 'keep',
        buffer: 'keep-dirty',
        dialog: 'keep-open',
      },
    };
  }
  if (options.bufferStillDirty) {
    return {
      kind: 'keep-dialog',
      action,
      mode: 'close-tab',
      message: REMAINING_CHANGES_MESSAGE,
      consequences: {
        route: 'unchanged',
        auth: 'unchanged',
        tab: 'keep-open',
        model: 'keep',
        buffer: 'keep-dirty',
        dialog: 'keep-open',
      },
    };
  }
  return {
    kind: 'proceed',
    action,
    consequences: {
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'close-captured',
      model: 'dispose-after-switch',
      buffer: 'remove',
      dialog: 'close',
    },
  };
}

export function applySaveAndCloseSettled(options: {
  capturedPath: ProjectRelativePath;
  dialogTargetsPath: boolean;
  saveStatus: 'saved' | 'failed' | 'skipped';
  bufferStillDirty: boolean;
  saveErrorMessage?: string;
}): GuardDecision {
  if (!options.dialogTargetsPath) {
    return applyCancel();
  }
  if (options.saveStatus === 'skipped') {
    if (!options.bufferStillDirty) {
      return {
        kind: 'proceed',
        action: { type: 'close-tab', path: options.capturedPath },
        consequences: {
          route: 'unchanged',
          auth: 'unchanged',
          tab: 'close-captured',
          model: 'dispose-after-switch',
          buffer: 'remove',
          dialog: 'close',
        },
      };
    }
    return {
      kind: 'keep-dialog',
      action: { type: 'close-tab', path: options.capturedPath },
      mode: 'close-tab',
      message: CLOSE_TAB_MESSAGE,
      consequences: {
        route: 'unchanged',
        auth: 'unchanged',
        tab: 'keep-open',
        model: 'keep',
        buffer: 'keep-dirty',
        dialog: 'keep-open',
      },
    };
  }
  return applySaveAndCloseResult({
    capturedPath: options.capturedPath,
    saveSucceeded: options.saveStatus === 'saved',
    bufferStillDirty: options.bufferStillDirty,
    saveErrorMessage: options.saveErrorMessage,
  });
}

export function applyDiscardClose(path: ProjectRelativePath): GuardDecision {
  return {
    kind: 'proceed',
    action: { type: 'close-tab', path },
    consequences: {
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'close-captured',
      model: 'dispose-after-switch',
      buffer: 'discard-then-remove',
      dialog: 'close',
    },
  };
}

export function applyCancel(): GuardDecision {
  return {
    kind: 'dismiss',
    consequences: {
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'unchanged',
      model: 'unchanged',
      buffer: 'unchanged',
      dialog: 'close',
    },
  };
}

export function requestLeaveWorkbench(dirtyCount: number): GuardDecision {
  if (dirtyCount === 0) {
    return {
      kind: 'proceed',
      action: { type: 'leave-workbench' },
      consequences: {
        route: 'leave-workbench',
        auth: 'unchanged',
        tab: 'unchanged',
        model: 'unchanged',
        buffer: 'unchanged',
        dialog: 'none',
      },
    };
  }
  return {
    kind: 'prompt',
    mode: 'leave',
    action: { type: 'leave-workbench' },
    message: LEAVE_MESSAGE,
    consequences: {
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'keep-open',
      model: 'keep',
      buffer: 'keep-dirty',
      dialog: 'open-leave',
    },
  };
}

export function requestLogout(dirtyCount: number): GuardDecision {
  if (dirtyCount === 0) {
    return {
      kind: 'proceed',
      action: { type: 'logout' },
      consequences: {
        route: 'login',
        auth: 'logout',
        tab: 'unchanged',
        model: 'unchanged',
        buffer: 'unchanged',
        dialog: 'none',
      },
    };
  }
  return {
    kind: 'prompt',
    mode: 'leave',
    action: { type: 'logout' },
    message: LEAVE_MESSAGE,
    consequences: {
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'keep-open',
      model: 'keep',
      buffer: 'keep-dirty',
      dialog: 'open-leave',
    },
  };
}

export function applyDiscardLeave(kind: 'leave-workbench' | 'logout'): GuardDecision {
  if (kind === 'logout') {
    return {
      kind: 'proceed',
      action: { type: 'logout' },
      consequences: {
        route: 'login',
        auth: 'logout',
        tab: 'unchanged',
        model: 'unchanged',
        buffer: 'discard-all-dirty',
        dialog: 'close',
      },
    };
  }
  return {
    kind: 'proceed',
    action: { type: 'leave-workbench' },
    consequences: {
      route: 'leave-workbench',
      auth: 'unchanged',
      tab: 'unchanged',
      model: 'unchanged',
      buffer: 'discard-all-dirty',
      dialog: 'close',
    },
  };
}

export function shouldPromptOnUnauthorized(): boolean {
  return false;
}

export function unauthorizedCleanupConsequences(): GuardConsequences {
  return {
    route: 'login',
    auth: 'unauthorized',
    tab: 'close-captured',
    model: 'dispose-after-switch',
    buffer: 'remove',
    dialog: 'none',
  };
}

export function shouldInstallBeforeUnload(dirtyCount: number): boolean {
  return dirtyCount > 0;
}

export function handleBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

export function useDirtyBeforeUnload(dirtyCount: number): void {
  const dirty = shouldInstallBeforeUnload(dirtyCount);
  useEffect(() => {
    if (!dirty) {
      return undefined;
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [dirty]);
}

export function useWorkbenchLeaveBlocker(dirtyCount: number) {
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      dirtyCount > 0 && currentLocation.pathname !== nextLocation.pathname,
    [dirtyCount],
  );
  return useBlocker(shouldBlock);
}

type OpenUnsavedDialog = Extract<UnsavedDialogState, { open: true }>;

let unsavedDialogState: UnsavedDialogState = { open: false };
const unsavedDialogListeners = new Set<() => void>();

function emitUnsavedDialog(): void {
  for (const listener of [...unsavedDialogListeners]) {
    listener();
  }
}

export function getUnsavedDialogState(): UnsavedDialogState {
  return unsavedDialogState;
}

export function subscribeUnsavedDialog(listener: () => void): () => void {
  unsavedDialogListeners.add(listener);
  return () => {
    unsavedDialogListeners.delete(listener);
  };
}

export function resetUnsavedDialog(): void {
  unsavedDialogState = { open: false };
  emitUnsavedDialog();
}

export function requestUnsavedDialog(next: OpenUnsavedDialog): 'opened' | 'busy' {
  if (unsavedDialogState.open) {
    return 'busy';
  }
  unsavedDialogState = next;
  emitUnsavedDialog();
  return 'opened';
}

export function dismissUnsavedDialog(): void {
  if (!unsavedDialogState.open) {
    return;
  }
  unsavedDialogState = { open: false };
  emitUnsavedDialog();
}

export function patchUnsavedDialog(patch: { message: string }): void {
  if (!unsavedDialogState.open) {
    return;
  }
  unsavedDialogState = { ...unsavedDialogState, message: patch.message };
  emitUnsavedDialog();
}

export function dialogTargetsClosePath(
  state: UnsavedDialogState,
  path: ProjectRelativePath,
): boolean {
  return state.open && state.action.type === 'close-tab' && state.action.path === path;
}

export function useUnsavedDialogState(): UnsavedDialogState {
  return useSyncExternalStore(subscribeUnsavedDialog, getUnsavedDialogState, getUnsavedDialogState);
}
