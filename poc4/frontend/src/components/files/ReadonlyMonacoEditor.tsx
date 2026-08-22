import '@/lib/monacoSetup';
import Editor from '@monaco-editor/react';
import type { ProjectRelativePath } from '@/contracts/file';
import { toProjectModelUri } from '@/lib/projectMonacoModels';

export function ReadonlyMonacoEditor({
  projectId,
  path,
  content,
  language,
}: {
  projectId: string;
  path: ProjectRelativePath;
  content: string;
  language: string;
}) {
  return (
    <Editor
      height="100%"
      path={toProjectModelUri(projectId, path).toString()}
      value={content}
      language={language}
      theme="vs-dark"
      options={{
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
