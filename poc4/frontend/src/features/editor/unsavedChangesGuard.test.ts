import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseProjectRelativePath } from '../files/pathPolicy';
import {
  applyCancel,
  applyDiscardClose,
  applyDiscardLeave,
  applySaveAndCloseResult,
  applySaveAndCloseSettled,
  capturedClosePath,
  CLOSE_TAB_MESSAGE,
  dismissUnsavedDialog,
  getUnsavedDialogState,
  handleBeforeUnload,
  LEAVE_MESSAGE,
  REMAINING_CHANGES_MESSAGE,
  requestCloseTab,
  requestLeaveWorkbench,
  requestLogout,
  requestUnsavedDialog,
  resetUnsavedDialog,
  shouldInstallBeforeUnload,
  shouldPromptOnUnauthorized,
  unauthorizedCleanupConsequences,
} from './unsavedChangesGuard';

const POM = parseProjectRelativePath('pom.xml');
const APP = parseProjectRelativePath('src/main/java/demo/App.java');

describe('unsavedChangesGuard transition matrix', () => {
  it('closes a clean tab immediately without a dialog or auth/route change', () => {
    const decision = requestCloseTab(POM, new Set());

    expect(decision.kind).toBe('proceed');
    expect(decision.action).toEqual({ type: 'close-tab', path: POM });
    expect(decision.consequences).toEqual({
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'close-captured',
      model: 'dispose-after-switch',
      buffer: 'remove',
      dialog: 'none',
    });
  });

  it('prompts Save and close for a dirty tab and freezes the captured path', () => {
    const decision = requestCloseTab(POM, new Set([POM, APP]));

    expect(decision.kind).toBe('prompt');
    expect(decision.mode).toBe('close-tab');
    expect(decision.action).toEqual({ type: 'close-tab', path: POM });
    expect(capturedClosePath(decision.action)).toBe(POM);
    expect(capturedClosePath(decision.action)).not.toBe(APP);
    expect(decision.consequences).toEqual({
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'keep-open',
      model: 'keep',
      buffer: 'keep-dirty',
      dialog: 'open-close-tab',
    });
  });

  it('closes after Save and close only when the captured buffer has no later edits', () => {
    const decision = applySaveAndCloseResult({
      capturedPath: POM,
      saveSucceeded: true,
      bufferStillDirty: false,
    });

    expect(decision.kind).toBe('proceed');
    expect(decision.action).toEqual({ type: 'close-tab', path: POM });
    expect(decision.consequences).toEqual({
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'close-captured',
      model: 'dispose-after-switch',
      buffer: 'remove',
      dialog: 'close',
    });
  });

  it('keeps the dialog and tab when Save and close fails', () => {
    const decision = applySaveAndCloseResult({
      capturedPath: POM,
      saveSucceeded: false,
      bufferStillDirty: true,
      saveErrorMessage: 'Unable to save file',
    });

    expect(decision.kind).toBe('keep-dialog');
    expect(decision.action).toEqual({ type: 'close-tab', path: POM });
    expect(decision.message).toBe('Unable to save file');
    expect(decision.consequences).toEqual({
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'keep-open',
      model: 'keep',
      buffer: 'keep-dirty',
      dialog: 'keep-open',
    });
  });

  it('keeps the dialog and tab when Save succeeds but the captured buffer was edited later', () => {
    const decision = applySaveAndCloseResult({
      capturedPath: POM,
      saveSucceeded: true,
      bufferStillDirty: true,
    });

    expect(decision.kind).toBe('keep-dialog');
    expect(decision.action).toEqual({ type: 'close-tab', path: POM });
    expect(decision.message).toBe(REMAINING_CHANGES_MESSAGE);
    expect(decision.consequences).toEqual({
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'keep-open',
      model: 'keep',
      buffer: 'keep-dirty',
      dialog: 'keep-open',
    });
  });

  it('Discard on a dirty tab closes only the captured path', () => {
    const decision = applyDiscardClose(POM);

    expect(decision.kind).toBe('proceed');
    expect(decision.action).toEqual({ type: 'close-tab', path: POM });
    expect(decision.consequences).toEqual({
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'close-captured',
      model: 'dispose-after-switch',
      buffer: 'discard-then-remove',
      dialog: 'close',
    });
  });

  it('Cancel has zero side effects on route, auth, tab, model and buffer', () => {
    const decision = applyCancel();

    expect(decision.kind).toBe('dismiss');
    expect(decision.consequences).toEqual({
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'unchanged',
      model: 'unchanged',
      buffer: 'unchanged',
      dialog: 'close',
    });
  });

  it('leaves the workbench immediately when nothing is dirty', () => {
    const decision = requestLeaveWorkbench(0);

    expect(decision.kind).toBe('proceed');
    expect(decision.action).toEqual({ type: 'leave-workbench' });
    expect(decision.consequences).toEqual({
      route: 'leave-workbench',
      auth: 'unchanged',
      tab: 'unchanged',
      model: 'unchanged',
      buffer: 'unchanged',
      dialog: 'none',
    });
  });

  it('blocks leaving the workbench when any buffer is dirty', () => {
    const decision = requestLeaveWorkbench(2);

    expect(decision.kind).toBe('prompt');
    expect(decision.mode).toBe('leave');
    expect(decision.action).toEqual({ type: 'leave-workbench' });
    expect(decision.consequences).toEqual({
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'keep-open',
      model: 'keep',
      buffer: 'keep-dirty',
      dialog: 'open-leave',
    });
  });

  it('Discard and leave drops dirty buffers then leaves without changing auth', () => {
    const decision = applyDiscardLeave('leave-workbench');

    expect(decision.kind).toBe('proceed');
    expect(decision.action).toEqual({ type: 'leave-workbench' });
    expect(decision.consequences).toEqual({
      route: 'leave-workbench',
      auth: 'unchanged',
      tab: 'unchanged',
      model: 'unchanged',
      buffer: 'discard-all-dirty',
      dialog: 'close',
    });
  });

  it('logs out immediately when nothing is dirty', () => {
    const decision = requestLogout(0);

    expect(decision.kind).toBe('proceed');
    expect(decision.action).toEqual({ type: 'logout' });
    expect(decision.consequences).toEqual({
      route: 'login',
      auth: 'logout',
      tab: 'unchanged',
      model: 'unchanged',
      buffer: 'unchanged',
      dialog: 'none',
    });
  });

  it('blocks logout when dirty and Cancel leaves auth intact', () => {
    const prompt = requestLogout(1);
    expect(prompt.kind).toBe('prompt');
    expect(prompt.mode).toBe('leave');
    expect(prompt.action).toEqual({ type: 'logout' });
    expect(prompt.consequences).toEqual({
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'keep-open',
      model: 'keep',
      buffer: 'keep-dirty',
      dialog: 'open-leave',
    });

    expect(applyCancel().consequences.auth).toBe('unchanged');
    expect(applyCancel().consequences.route).toBe('unchanged');
  });

  it('Discard and leave on logout proceeds to login and existing cleanup', () => {
    const decision = applyDiscardLeave('logout');

    expect(decision.kind).toBe('proceed');
    expect(decision.action).toEqual({ type: 'logout' });
    expect(decision.consequences).toEqual({
      route: 'login',
      auth: 'logout',
      tab: 'unchanged',
      model: 'unchanged',
      buffer: 'discard-all-dirty',
      dialog: 'close',
    });
  });

  it('never opens a cancellable dirty dialog on current-token 401', () => {
    expect(shouldPromptOnUnauthorized()).toBe(false);
    expect(unauthorizedCleanupConsequences()).toEqual({
      route: 'login',
      auth: 'unauthorized',
      tab: 'close-captured',
      model: 'dispose-after-switch',
      buffer: 'remove',
      dialog: 'none',
    });
  });

  it('installs one beforeunload handler only while dirty exists and never sets custom text', () => {
    expect(shouldInstallBeforeUnload(0)).toBe(false);
    expect(shouldInstallBeforeUnload(1)).toBe(true);

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    Object.defineProperty(event, 'returnValue', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    handleBeforeUnload(event);

    expect(event.defaultPrevented).toBe(true);
    expect(event.returnValue).toBeUndefined();
  });
});

describe('unsavedChangesGuard capture isolation', () => {
  beforeEach(() => {});
  afterEach(() => {});

  it('does not retarget a captured close path after a later active tab change', () => {
    const prompt = requestCloseTab(POM, new Set([POM]));
    const laterActive = APP;

    expect(capturedClosePath(prompt.action)).toBe(POM);
    expect(capturedClosePath(prompt.action)).not.toBe(laterActive);

    const saved = applySaveAndCloseResult({
      capturedPath: capturedClosePath(prompt.action)!,
      saveSucceeded: true,
      bufferStillDirty: false,
    });
    expect(saved.action).toEqual({ type: 'close-tab', path: POM });
    expect(saved.consequences.tab).toBe('close-captured');
  });

  it('does not close the captured tab when Save-and-close settles after Cancel', () => {
    const decision = applySaveAndCloseSettled({
      capturedPath: POM,
      dialogTargetsPath: false,
      saveStatus: 'saved',
      bufferStillDirty: false,
    });

    expect(decision.kind).toBe('dismiss');
    expect(decision.consequences).toEqual({
      route: 'unchanged',
      auth: 'unchanged',
      tab: 'unchanged',
      model: 'unchanged',
      buffer: 'unchanged',
      dialog: 'close',
    });
  });

  it('closes after skipped Save-and-close when the captured buffer is already clean', () => {
    const decision = applySaveAndCloseSettled({
      capturedPath: POM,
      dialogTargetsPath: true,
      saveStatus: 'skipped',
      bufferStillDirty: false,
    });

    expect(decision.kind).toBe('proceed');
    expect(decision.action).toEqual({ type: 'close-tab', path: POM });
    expect(decision.consequences.tab).toBe('close-captured');
    expect(decision.consequences.dialog).toBe('close');
  });

  it('keeps the dialog after skipped Save-and-close when the captured buffer is still dirty', () => {
    const decision = applySaveAndCloseSettled({
      capturedPath: POM,
      dialogTargetsPath: true,
      saveStatus: 'skipped',
      bufferStillDirty: true,
    });

    expect(decision.kind).toBe('keep-dialog');
    expect(decision.action).toEqual({ type: 'close-tab', path: POM });
    expect(decision.consequences.tab).toBe('keep-open');
    expect(decision.consequences.buffer).toBe('keep-dirty');
    expect(decision.consequences.dialog).toBe('keep-open');
  });
});

describe('unsavedChangesGuard exclusive dialog', () => {
  beforeEach(() => {
    resetUnsavedDialog();
  });

  afterEach(() => {
    resetUnsavedDialog();
  });

  it('rejects a second dialog request while one command is already open', () => {
    expect(
      requestUnsavedDialog({
        open: true,
        mode: 'close-tab',
        action: { type: 'close-tab', path: POM },
        message: CLOSE_TAB_MESSAGE,
      }),
    ).toBe('opened');
    expect(
      requestUnsavedDialog({
        open: true,
        mode: 'leave',
        action: { type: 'leave-workbench' },
        message: LEAVE_MESSAGE,
      }),
    ).toBe('busy');
    expect(getUnsavedDialogState()).toMatchObject({
      open: true,
      mode: 'close-tab',
      action: { type: 'close-tab', path: POM },
    });
    dismissUnsavedDialog();
    expect(getUnsavedDialogState()).toEqual({ open: false });
  });
});
