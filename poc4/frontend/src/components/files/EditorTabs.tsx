import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, type DragEvent } from 'react';
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
}

export function EditorTabs({ tabs, activePath, onSelect, onClose, onReorder }: EditorTabsProps) {
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

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    <div className="h-[36px] shrink-0 overflow-x-auto overflow-y-hidden">
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
                  'group-hover:opacity-100',
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
  );
}
