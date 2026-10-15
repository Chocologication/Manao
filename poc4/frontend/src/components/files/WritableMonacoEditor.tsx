import '@/lib/monacoSetup';
import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { workspaceBufferRegistry } from '@/app/appRuntime';
import type { ProjectRelativePath } from '@/contracts/file';
import { toProjectModelUri } from '@/lib/projectMonacoModels';
import { ensureWorkspaceBuffer } from './editorSaveCommand';
import { useEditorPreferences } from '@/features/editor/editorPreferences';
import { useThemePreferences } from '@/features/preferences/themePreferences';
import { useEditorNavigation } from '@/features/editor/editorNavigation';

export function WritableMonacoEditor({
  projectId,
  path,
  content,
  language,
  readOnly,
  onSave,
}: {
  projectId: string;
  path: ProjectRelativePath;
  content: string;
  language: string;
  readOnly: boolean;
  onSave: () => void;
}) {
  const preferences = useEditorPreferences();
  const theme = useThemePreferences((state) => state.theme);
  const uri = toProjectModelUri(projectId, path);
  const onSaveRef = useRef(onSave);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const target = useEditorNavigation((state) => state.target);
  onSaveRef.current = onSave;

  const revealTarget = useCallback(() => {
    const current = useEditorNavigation.getState().target;
    const editor = editorRef.current;
    if (!current || !editor || current.projectId !== projectId || current.path !== path) return;
    const line = Math.min(editor.getModel()?.getLineCount() ?? 1, Math.max(1, current.line));
    const column = Math.min(editor.getModel()?.getLineMaxColumn(line) ?? 1, Math.max(1, current.column));
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
    useEditorNavigation.getState().clear(current);
  }, [path, projectId]);

  useEffect(() => {
    revealTarget();
  }, [target, revealTarget]);

  useLayoutEffect(() => {
    const existing = workspaceBufferRegistry.get(projectId, path);
    if (existing?.kind === 'monaco') {
      return;
    }
    const modelUri = toProjectModelUri(projectId, path);
    let model = monaco.editor.getModel(modelUri);
    if (model === null) {
      model = monaco.editor.createModel(content, language, modelUri);
    }
    ensureWorkspaceBuffer({
      projectId,
      path,
      kind: 'monaco',
      model,
    });
  }, [projectId, path, content, language]);

  return (
    <Editor
      height="100%"
      path={uri.toString()}
      defaultValue={content}
      language={language}
      theme={`manao-${theme}`}
      keepCurrentModel
      saveViewState
      onMount={(editor) => {
        editorRef.current = editor;
        revealTarget();
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          onSaveRef.current();
        });
      }}
      options={{
        readOnly,
        domReadOnly: readOnly,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        fontFamily: 'Cascadia Code, Consolas, monospace',
        fontSize: preferences.fontSize,
        lineHeight: 24,
        padding: { top: 18, bottom: 18 },
        minimap: { enabled: preferences.minimap },
        wordWrap: preferences.wordWrap ? 'on' : 'off',
        renderLineHighlight: 'line',
        smoothScrolling: false,
      }}
    />
  );
}
