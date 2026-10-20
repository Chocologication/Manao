import { motion } from 'framer-motion';
import { Save, X, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useEditorPreferences } from '@/features/editor/editorPreferences';
import { useReducedMotion } from '@/features/preferences/motionPreferences';
import { Spinner } from '@/components/ui/spinner';
import type { EditorTab } from '@/features/editor/editorTypes';
import { springFast } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { getFileIcon, getFileIconColor } from './fileIcons';

interface EditorTabsProps {
  tabs: EditorTab[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onSave?: () => void;
  saveDisabled?: boolean;
  savePending?: boolean;
}

export function EditorTabs({
  tabs,
  activePath,
  onSelect,
  onClose,
  onReorder,
  onSave,
  saveDisabled = true,
  savePending = false,
}: EditorTabsProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const preferences = useEditorPreferences();
  const draggedIndexRef = useRef<number | null>(null);
  const tabRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleDragStart = useCallback((e: DragEvent, index: number) => {
    draggedIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent, toIndex: number) => {
      e.preventDefault();
      const fromIndex = draggedIndexRef.current;
      if (fromIndex !== null && fromIndex !== toIndex) {
        onReorder(fromIndex, toIndex);
      }
      draggedIndexRef.current = null;
    },
    [onReorder]
  );

  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!activePath) return;
    const frameId = requestAnimationFrame(() => {
      const tabEl = tabRefsRef.current.get(activePath);
      tabEl?.scrollIntoView?.({
        behavior: reduceMotion ? 'auto' : 'smooth',
        inline: 'nearest',
        block: 'nearest',
      });
    });
    return () => cancelAnimationFrame(frameId);
  }, [activePath, reduceMotion]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="lab-editor-tabs flex h-[36px] shrink-0 items-center">
      <div className="h-[36px] min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div role="tablist" aria-label="Editor tabs" className="flex h-[36px] w-max">
          {tabs.map((tab, index) => {
            const isActive = tab.path === activePath;
            const Icon = getFileIcon(tab.title, false);
            const iconColor = getFileIconColor(tab.title, false);

            return (
              <div
                key={tab.path}
                ref={(el) => {
                  if (el) tabRefsRef.current.set(tab.path, el);
                  else tabRefsRef.current.delete(tab.path);
                }}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, index)}
                onClick={() => onSelect(tab.path)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) {
                    return;
                  }
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(tab.path);
                  }
                }}
                role="tab"
                title={tab.path}
                aria-selected={isActive}
                tabIndex={0}
                className={cn(
                  'group relative flex h-[36px] min-w-[120px] max-w-[180px] cursor-pointer select-none items-center gap-2 border-r px-3 text-sm transition-colors',
                  isActive
                    ? 'text-foreground'
                    : 'bg-muted/30 text-muted-foreground hover:bg-muted/50'
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="editor-tab-indicator"
                    className="absolute inset-x-0 top-0 h-[2px] bg-primary"
                    transition={reduceMotion ? { duration: 0 } : springFast}
                  />
                )}

                <Icon className={cn('h-4 w-4 shrink-0', iconColor)} aria-hidden />

                <span className="flex-1 truncate">
                  {tab.isDirty && <span className="mr-0.5">*</span>}
                  {tab.title}
                </span>

                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.path);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                  }}
                  className={cn(
                    'shrink-0 rounded p-0.5 text-primary opacity-0 transition-opacity hover:bg-primary/20',
                    'group-hover:opacity-100 focus-visible:opacity-100',
                    isActive && 'opacity-60'
                  )}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {onSave !== undefined ? (
        <button
          type="button"
          title="Save"
          aria-label="Save"
          disabled={saveDisabled}
          onClick={onSave}
          className="mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64"
        >
          {savePending ? <Spinner /> : <Save className="size-4" aria-hidden />}
        </button>
      ) : null}
      <button type="button" className="lab-editor-settings-button" aria-label="编辑器设置" title="编辑器设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={16} /></button>
      {settingsOpen && <div className="lab-editor-settings" role="group" aria-label="编辑器设置" onKeyDown={(event) => { if (event.key === 'Escape') setSettingsOpen(false); }}><label>字号 <input type="number" min={12} max={24} value={preferences.fontSize} onChange={(event) => preferences.update({ fontSize: Number(event.target.value) })} /></label><label>自动换行 <input type="checkbox" checked={preferences.wordWrap} onChange={(event) => preferences.update({ wordWrap: event.target.checked })} /></label><label>代码缩略图 <input type="checkbox" checked={preferences.minimap} onChange={(event) => preferences.update({ minimap: event.target.checked })} /></label><button type="button" onClick={() => setSettingsOpen(false)}>关闭</button></div>}
    </div>
  );
}
