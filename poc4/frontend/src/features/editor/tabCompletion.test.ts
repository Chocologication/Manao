import * as monaco from 'monaco-editor';
import type { RegisterCompletionOptions } from 'monacopilot';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestTabCompletion } from '../../api/codeCompletionApi';
import { toProjectModelUri } from '../../lib/projectMonacoModels';
import { parseProjectRelativePath } from '../files/pathPolicy';
import { registerTabCompletion } from './tabCompletion';

const library = vi.hoisted(() => ({ registrations: [] as { options: RegisterCompletionOptions; deregister: ReturnType<typeof vi.fn> }[] }));
vi.mock('monacopilot', () => ({ registerCompletion: vi.fn((_monaco, _editor, options) => {
  const entry = { options, deregister: vi.fn() };
  library.registrations.push(entry);
  return entry;
}) }));
vi.mock('../../api/codeCompletionApi', () => ({ requestTabCompletion: vi.fn() }));

const cleanups: (() => void)[] = [];
beforeEach(() => { library.registrations.length = 0; vi.mocked(requestTabCompletion).mockReset(); });
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  monaco.editor.getModels().forEach((model) => model.dispose());
  vi.useRealTimers();
});

function fixture(identity = { projectId: 'project', path: 'file.py', language: 'python' }) {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const listen = (name: string) => (callback: (event: any) => void) => {
    const entries = listeners.get(name) ?? new Set();
    listeners.set(name, entries); entries.add(callback);
    return { dispose: () => entries.delete(callback) };
  };
  const emit = (name: string, event: any = {}) => [...(listeners.get(name) ?? [])].forEach((callback) => callback(event));
  const newModel = (projectId: string, path: string, language: string, text = 'def add(a, b):\n    return \n') =>
    monaco.editor.createModel(text, language, toProjectModelUri(projectId, parseProjectRelativePath(path)));
  let model = newModel(identity.projectId, identity.path, identity.language);
  let position = { lineNumber: 2, column: 12 };
  let readOnly = false;
  let focus = true;
  let emptySelection = true;
  const editor = {
    getModel: () => model, getPosition: () => position,
    getSelection: () => ({ isEmpty: () => emptySelection }),
    hasTextFocus: () => focus, getOption: () => readOnly, trigger: vi.fn(),
    onDidChangeModelContent: listen('content'), onDidChangeCursorPosition: listen('cursor'),
    onDidChangeCursorSelection: listen('selection'), onDidChangeModel: listen('model'),
    onDidChangeModelLanguage: listen('language'), onDidBlurEditorText: listen('blur'),
    onDidChangeConfiguration: listen('configuration'), onKeyDown: listen('key'), onDidDispose: listen('dispose'),
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  const register = (props = identity) => {
    const cleanup = registerTabCompletion({ monaco, editor, ...props });
    cleanups.push(cleanup);
    return cleanup;
  };
  const metadata = () => {
    const offset = model.getOffsetAt(position);
    return { body: { completionMetadata: { language: identity.language, filename: identity.path,
      technologies: undefined, relatedFiles: undefined, cursorPosition: { ...position },
      textBeforeCursor: model.getValue().slice(0, offset), textAfterCursor: model.getValue().slice(offset) } } };
  };
  return { editor, emit, register, metadata, newModel,
    handler: () => library.registrations.at(-1)!.options.requestHandler!,
    setModel: (value: monaco.editor.ITextModel) => { model = value; emit('model'); },
    edit: (text: string) => { model.setValue(text); emit('content'); },
    move: () => { position = { ...position, column: position.column + 1 }; emit('cursor'); },
    select: () => { emptySelection = false; emit('selection'); },
    blur: () => { focus = false; emit('blur'); },
    readonly: (value: boolean) => { readOnly = value; emit('configuration', { hasChanged: () => true }); },
    listeners: () => [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0),
  };
}

function deferred() {
  let resolve!: (value: { completion: string | null }) => void;
  const promise = new Promise<{ completion: string | null }>((done) => { resolve = done; });
  return { promise, resolve };
}

it('uses unsaved buffer whitespace and retains automatic follow-up with global caching disabled', async () => {
  const f = fixture(); f.register();
  f.edit('def add(a, b):\n    return \n# unsaved');
  vi.mocked(requestTabCompletion).mockResolvedValue({ completion: 'a + b' });
  await expect(f.handler()(f.metadata())).resolves.toEqual({ completion: 'a + b' });
  expect(requestTabCompletion).toHaveBeenCalledWith('project', { prefix: 'def add(a, b):\n    return ', suffix: '\n# unsaved' }, expect.any(AbortSignal));
  expect(library.registrations[0]!.options).toMatchObject({ trigger: 'onIdle', maxContextLines: 100,
    enableCaching: false, allowFollowUpCompletions: true });
});

it.each(['text', 'cursor'])('rejects old debounce metadata after a %s change before sending', async (change) => {
  const f = fixture(); f.register(); const old = f.metadata();
  if (change === 'text') f.edit('def sub(a, b):\n    return \n'); else f.move();
  await expect(f.handler()(old)).resolves.toEqual({ completion: null });
  expect(requestTabCompletion).not.toHaveBeenCalled();
});

it.each(['content', 'cursor', 'selection', 'blur', 'esc', 'readonly', 'dispose'])('aborts and discards a late response after %s', async (event) => {
  const f = fixture(); const cleanup = f.register(); const oldHandler = f.handler();
  const result = deferred(); vi.mocked(requestTabCompletion).mockReturnValue(result.promise);
  const pending = oldHandler(f.metadata());
  const signal = vi.mocked(requestTabCompletion).mock.calls[0]![2];
  if (event === 'content') f.edit('def sub(a, b):\n    return \n');
  if (event === 'cursor') f.move();
  if (event === 'selection') f.select();
  if (event === 'blur') f.blur();
  if (event === 'esc') f.emit('key', { keyCode: monaco.KeyCode.Escape });
  if (event === 'readonly') f.readonly(true);
  if (event === 'dispose') cleanup();
  expect(signal.aborted).toBe(true);
  result.resolve({ completion: 'stale' });
  await expect(pending).resolves.toEqual({ completion: null });
});

it('does not let request A completion clear request B cancellation or timer', async () => {
  const f = fixture(); f.register(); const a = deferred(); const b = deferred();
  vi.mocked(requestTabCompletion).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const first = f.handler()(f.metadata()); const second = f.handler()(f.metadata());
  expect(vi.mocked(requestTabCompletion).mock.calls[0]![2].aborted).toBe(true);
  a.resolve({ completion: 'old' }); await expect(first).resolves.toEqual({ completion: null });
  f.emit('key', { keyCode: monaco.KeyCode.Escape });
  expect(vi.mocked(requestTabCompletion).mock.calls[1]![2].aborted).toBe(true);
  b.resolve({ completion: 'new-but-cancelled' }); await expect(second).resolves.toEqual({ completion: null });
});

it.each(['props-first', 'model-first'])('waits for matching props and actual model in %s switches', async (order) => {
  const f = fixture(); const cleanup = f.register(); const old = f.handler(); const oldMetadata = f.metadata();
  const next = { projectId: 'other', path: 'file.ts', language: 'typescript' };
  const nextModel = f.newModel(next.projectId, next.path, next.language);
  if (order === 'model-first') f.setModel(nextModel);
  cleanup(); f.register(next);
  if (order === 'props-first') {
    expect(library.registrations).toHaveLength(1);
    f.setModel(nextModel);
  }
  expect(library.registrations.at(-1)!.options).toMatchObject({ filename: 'file.ts', language: 'typescript' });
  await expect(old(oldMetadata)).resolves.toEqual({ completion: null });
  vi.mocked(requestTabCompletion).mockResolvedValue({ completion: 'next' });
  await expect(f.handler()(f.metadata())).resolves.toEqual({ completion: 'next' });
  expect(vi.mocked(requestTabCompletion).mock.calls[0]![0]).toBe('other');
});

it('deregisters on language mismatch and only resumes on a matching language', async () => {
  const f = fixture(); f.register(); const old = f.handler(); const metadata = f.metadata();
  monaco.editor.setModelLanguage(f.editor.getModel()!, 'typescript'); f.emit('language');
  expect(library.registrations[0]!.deregister).toHaveBeenCalledOnce();
  monaco.editor.setModelLanguage(f.editor.getModel()!, 'python'); f.emit('language');
  expect(library.registrations).toHaveLength(2);
  await expect(old(metadata)).resolves.toEqual({ completion: null });
  expect(requestTabCompletion).not.toHaveBeenCalled();
});

it('disables readonly requests, hides suggestions, and cleans all listeners and timers idempotently', async () => {
  vi.useFakeTimers(); const f = fixture(); f.readonly(true); const cleanup = f.register();
  expect(library.registrations).toHaveLength(0);
  f.readonly(false); expect(library.registrations).toHaveLength(1);
  vi.mocked(requestTabCompletion).mockResolvedValue({ completion: null });
  await f.handler()(f.metadata());
  cleanup(); cleanup();
  expect(library.registrations[0]!.deregister).toHaveBeenCalledOnce();
  expect(f.editor.trigger).toHaveBeenCalledWith(expect.any(String), 'editor.action.inlineSuggest.hide', {});
  expect(f.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it('bounds hanging browser requests at six seconds without accepting their later result', async () => {
  vi.useFakeTimers(); const f = fixture(); f.register(); const result = deferred();
  vi.mocked(requestTabCompletion).mockReturnValue(result.promise);
  const pending = f.handler()(f.metadata()); await vi.advanceTimersByTimeAsync(6000);
  expect(vi.mocked(requestTabCompletion).mock.calls[0]![2].aborted).toBe(true);
  result.resolve({ completion: 'late' }); await expect(pending).resolves.toEqual({ completion: null });
});

it.each([null, 'error'])('silently returns an empty suggestion for %s', async (value) => {
  const f = fixture(); f.register();
  if (value === 'error') vi.mocked(requestTabCompletion).mockRejectedValue(new Error('503'));
  else vi.mocked(requestTabCompletion).mockResolvedValue({ completion: null });
  await expect(f.handler()(f.metadata())).resolves.toEqual({ completion: null });
});

it('clips each context side without trimming whitespace or splitting surrogate pairs', async () => {
  const f = fixture(); f.register();
  const prefix = 'x\uD83D\uDE00' + ' '.repeat(15999);
  const suffix = ' '.repeat(15999) + '\uD83D\uDE00x';
  f.edit('def add(a, b):\n    return \n');
  // A second fixture places the cursor on a long line, as real metadata does.
  const model = f.editor.getModel()!;
  model.setValue(prefix + suffix);
  vi.spyOn(f.editor, 'getPosition').mockReturnValue(new monaco.Position(1, prefix.length + 1));
  vi.mocked(requestTabCompletion).mockResolvedValue({ completion: null });
  await f.handler()({ body: { completionMetadata: { ...f.metadata().body.completionMetadata,
    cursorPosition: { lineNumber: 1, column: prefix.length + 1 }, textBeforeCursor: prefix, textAfterCursor: suffix } } });
  expect(vi.mocked(requestTabCompletion).mock.calls[0]![1]).toEqual({ prefix: ' '.repeat(15999), suffix: ' '.repeat(15999) });
});
