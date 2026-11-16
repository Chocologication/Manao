import { registerCompletion, type RegisterCompletionOptions } from 'monacopilot';
import type * as Monaco from 'monaco-editor';
import { requestTabCompletion } from '../../api/codeCompletionApi';
import { toProjectModelUri } from '../../lib/projectMonacoModels';
import { parseProjectRelativePath } from '../files/pathPolicy';

type Options = {
  monaco: typeof Monaco;
  editor: Monaco.editor.IStandaloneCodeEditor;
  projectId: string;
  path: string;
  language: string;
};
type Handler = NonNullable<RegisterCompletionOptions['requestHandler']>;

// UTF-16 bounds match the Java DTO; discard a split surrogate at either edge.
function clipContext(text: string, keepEnd: boolean): string {
  if (text.length <= 16000) return text;
  let clipped = keepEnd ? text.slice(-16000) : text.slice(0, 16000);
  if (keepEnd && /[\uDC00-\uDFFF]/.test(clipped[0]!)) clipped = clipped.slice(1);
  if (!keepEnd && /[\uD800-\uDBFF]/.test(clipped.at(-1)!)) clipped = clipped.slice(0, -1);
  return clipped;
}

/** One editor registration; the workspace continues to own its model and saves. */
export function registerTabCompletion({ monaco, editor, projectId, path, language }: Options): () => void {
  const expectedUri = toProjectModelUri(projectId, parseProjectRelativePath(path)).toString();
  let disposed = false;
  let sequence = 0;
  let generation = 0;
  let active: { controller: AbortController; timer: ReturnType<typeof setTimeout> } | undefined;
  let registration: ReturnType<typeof registerCompletion> | undefined;

  const invalidate = () => {
    sequence++;
    if (active) {
      active.controller.abort();
      clearTimeout(active.timer);
      active = undefined;
    }
  };
  const matchesIdentity = (model: Monaco.editor.ITextModel | null) => model !== null && !model.isDisposed()
    && model.uri.toString() === expectedUri && model.getLanguageId() === language;
  const canRequest = () => !disposed && matchesIdentity(editor.getModel()) && editor.hasTextFocus()
    && !editor.getOption(monaco.editor.EditorOption.readOnly) && editor.getSelection()?.isEmpty() === true;
  const samePosition = (a: Monaco.IPosition | null, b: Monaco.IPosition) => a?.lineNumber === b.lineNumber && a.column === b.column;

  const handleRequest = (registeredGeneration: number): Handler => async ({ body }) => {
    const metadata = body.completionMetadata;
    const model = editor.getModel();
    const position = editor.getPosition();
    if (registeredGeneration !== generation || !canRequest() || !model || !position
      || !samePosition(position, metadata.cursorPosition)) return { completion: null };
    const text = model.getValue();
    const offset = model.getOffsetAt(position);
    // Monacopilot creates metadata BEFORE its 400 ms debounce. Never attach a
    // new version snapshot to metadata that no longer describes this buffer.
    if (!text.slice(0, offset).endsWith(metadata.textBeforeCursor)
      || !text.slice(offset).startsWith(metadata.textAfterCursor)) return { completion: null };

    invalidate();
    const requestSequence = sequence;
    const version = model.getVersionId();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    active = { controller, timer };
    try {
      const result = await requestTabCompletion(projectId, {
        prefix: clipContext(metadata.textBeforeCursor, true),
        suffix: clipContext(metadata.textAfterCursor, false),
      }, controller.signal);
      if (controller.signal.aborted || requestSequence !== sequence || registeredGeneration !== generation
        || !canRequest() || editor.getModel() !== model || model.isDisposed()
        || model.getVersionId() !== version || !samePosition(editor.getPosition(), position)) return { completion: null };
      return { completion: typeof result.completion === 'string' ? result.completion : null };
    } catch {
      // HttpClient has already applied the existing 401 session cleanup.
      return { completion: null };
    } finally {
      clearTimeout(timer);
      if (active?.controller === controller) active = undefined;
    }
  };

  const stopRegistration = () => {
    invalidate();
    generation++;
    editor.trigger('manao-tab-completion', 'editor.action.inlineSuggest.hide', {});
    registration?.deregister();
    registration = undefined;
  };
  const syncRegistration = () => {
    stopRegistration();
    if (disposed || !matchesIdentity(editor.getModel()) || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    registration = registerCompletion(monaco, editor, {
      language, filename: path, trigger: 'onIdle', maxContextLines: 100,
      enableCaching: false, allowFollowUpCompletions: true,
      triggerIf: canRequest, requestHandler: handleRequest(generation),
    });
  };
  const listeners = [
    editor.onDidChangeModelContent(invalidate),
    editor.onDidChangeCursorPosition(invalidate),
    editor.onDidChangeCursorSelection(invalidate),
    editor.onDidBlurEditorText(invalidate),
    editor.onDidChangeModel(syncRegistration),
    editor.onDidChangeModelLanguage(syncRegistration),
    editor.onDidChangeConfiguration((event) => {
      if (event.hasChanged(monaco.editor.EditorOption.readOnly)) syncRegistration();
    }),
    editor.onKeyDown((event) => { if (event.keyCode === monaco.KeyCode.Escape) invalidate(); }),
    editor.onDidDispose(() => cleanup()),
  ];
  function cleanup() {
    if (disposed) return;
    disposed = true;
    stopRegistration();
    listeners.forEach((listener) => listener.dispose());
  }
  syncRegistration();
  return cleanup;
}
