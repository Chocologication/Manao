import { useEffect, useMemo, useRef, useState } from 'react';
import { Command, FileCode2, Package, PanelLeft, PanelRight, Play, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';

type WorkbenchPanel = 'file' | 'run' | 'dependencies';
type WorkbenchCommand = { name: string; icon: LucideIcon; run: () => void };

export function WorkbenchCommands({ python, onSelectPanel, onToggleFiles, onToggleInsights }: {
  python: boolean;
  onSelectPanel: (panel: WorkbenchPanel) => void;
  onToggleFiles: () => void;
  onToggleInsights: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const paths = useWorkspaceSession((state) => state.openPaths);
  const commands = useMemo<WorkbenchCommand[]>(() => [
    { name: '代码编辑器', icon: FileCode2, run: () => onSelectPanel('file') },
    { name: '运行与日志', icon: Play, run: () => onSelectPanel('run') },
    ...(python ? [{ name: 'Python 依赖管理', icon: Package, run: () => onSelectPanel('dependencies') }] : []),
    { name: '切换文件面板', icon: PanelLeft, run: onToggleFiles },
    { name: '切换项目洞察', icon: PanelRight, run: onToggleInsights },
    ...paths.map((path) => ({
      name: String(path),
      icon: FileCode2,
      run: () => { useWorkspaceSession.getState().openFile(path); onSelectPanel('file'); },
    })),
  ].filter((command) => command.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  [onSelectPanel, onToggleFiles, onToggleInsights, paths, python, query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      setQuery('');
      setActiveIndex(0);
      if (!element.open) {
        if (typeof element.showModal === 'function') element.showModal();
        else element.setAttribute('open', '');
      }
      input.current?.focus();
    } else if (element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => {
    const active = dialog.current?.querySelector<HTMLElement>(`[data-command-index="${activeIndex}"]`);
    if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function execute(index: number): void {
    const command = commands[index];
    if (!command) return;
    setOpen(false);
    command.run();
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(0, commands.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Home' && commands.length > 0) {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End' && commands.length > 0) {
      event.preventDefault();
      setActiveIndex(commands.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      execute(activeIndex);
    }
  }

  return (
    <>
      <Button type="button" variant="ghost" size="icon" title="命令面板" aria-label="命令面板" onClick={() => setOpen(true)}>
        <Command aria-hidden="true" />
      </Button>
      <dialog
        ref={dialog}
        className="lab-command-dialog"
        aria-label="命令面板"
        onCancel={(event) => { event.preventDefault(); setOpen(false); }}
        onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      >
        <div className="lab-command-search">
          <Command aria-hidden="true" size={18} />
          <input
            ref={input}
            role="combobox"
            aria-label="搜索命令或已打开文件"
            aria-expanded="true"
            aria-controls="lab-command-options"
            aria-activedescendant={commands.length > 0 ? `lab-command-option-${activeIndex}` : undefined}
            placeholder="搜索命令或已打开文件…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <Button type="button" variant="ghost" size="icon" aria-label="关闭命令面板" onClick={() => setOpen(false)}>
            <X aria-hidden="true" size={17} />
          </Button>
        </div>
        {commands.length > 0 ? (
          <ul id="lab-command-options" role="listbox" aria-label="可用命令">
            {commands.map((command, index) => {
              const Icon = command.icon;
              return (
                <li key={command.name} role="none">
                  <button
                    id={`lab-command-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    data-active={index === activeIndex}
                    data-command-index={index}
                    onPointerMove={() => setActiveIndex(index)}
                    onClick={() => execute(index)}
                  >
                    <Icon aria-hidden="true" size={16} />
                    <span>{command.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <p className="lab-command-empty">没有匹配的命令或文件</p>}
      </dialog>
    </>
  );
}
