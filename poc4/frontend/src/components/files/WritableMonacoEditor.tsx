import '@/lib/monacoSetup';
import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { useLayoutEffect, useRef } from 'react';
import { workspaceBufferRegistry } from '@/app/appRuntime';
import type { ProjectRelativePath } from '@/contracts/file';
import { toProjectModelUri } from '@/lib/projectMonacoModels';
import { ensureWorkspaceBuffer } from './editorSaveCommand';

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
  const uri = toProjectModelUri(projectId, path);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

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
      theme="vs-dark"
      keepCurrentModel
      saveViewState
      onMount={(editor) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          onSaveRef.current();
        });
      }}
      options={{
        readOnly,
        domReadOnly: readOnly,
        automaticLayout: true,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
