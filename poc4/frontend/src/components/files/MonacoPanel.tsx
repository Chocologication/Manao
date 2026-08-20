import '@/lib/monacoSetup';
import Editor from '@monaco-editor/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EditorTab } from '@/features/editor/editorTypes';
import { disposeAllPoc4Models, disposeModel, toModelUri } from '@/lib/monacoModels';
import { mockFiles, type MockFile } from '@/spike/mockFiles';
import { EditorTabs } from './EditorTabs';

type OpenFile = MockFile & { isDirty: boolean };

export function MonacoPanel() {
  const originals = useMemo(() => new Map(mockFiles.map((file) => [file.path, file.content])), []);
  const [files, setFiles] = useState<OpenFile[]>(() =>
    mockFiles.map((file) => ({ ...file, isDirty: false }))
  );
  const [activePath, setActivePath] = useState(mockFiles[0].path);

  const tabs: EditorTab[] = files.map(({ path, title, isDirty }) => ({ path, title, isDirty }));
  const activeFile = files.find((file) => file.path === activePath);

  const updateContent = useCallback(
    (path: string, value: string) => {
      setFiles((current) =>
        current.map((file) =>
          file.path === path
            ? { ...file, content: value, isDirty: value !== originals.get(path) }
            : file
        )
      );
    },
    [originals]
  );

  const handleClose = useCallback(
    (path: string) => {
      setFiles((current) => {
        const next = current.filter((file) => file.path !== path);
        setActivePath((active) => (active === path ? (next[0]?.path ?? '') : active));
        return next;
      });
      disposeModel(path);
    },
    []
  );

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    setFiles((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return current;
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  useEffect(() => () => disposeAllPoc4Models(), []);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <EditorTabs
        tabs={tabs}
        activePath={activePath}
        onSelect={setActivePath}
        onClose={handleClose}
        onReorder={handleReorder}
      />
      <div className="min-h-0 min-w-0 flex-1">
        {activeFile ? (
          <Editor
            height="100%"
            path={toModelUri(activeFile.path).toString()}
            value={activeFile.content}
            language={activeFile.language}
            theme="vs-dark"
            onChange={(value) => updateContent(activeFile.path, value ?? '')}
            options={{ automaticLayout: true, scrollBeyondLastLine: false }}
          />
        ) : null}
      </div>
    </div>
  );
}
