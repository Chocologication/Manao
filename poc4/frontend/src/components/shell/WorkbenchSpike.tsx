import { FileCode, Play, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import { MonacoPanel } from '@/components/files/MonacoPanel';
import { TerminalPanel } from '@/components/terminal/TerminalPanel';
import { cn } from '@/lib/utils';

const panels = [
  { id: 'file', label: 'File', icon: FileCode },
  { id: 'run', label: 'Run', icon: Play },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
] as const;

type ActivePanel = (typeof panels)[number]['id'];

export function WorkbenchSpike() {
  const [activePanel, setActivePanel] = useState<ActivePanel>('file');

  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      <aside className="flex w-[256px] shrink-0 flex-col border-r">
        <div className="flex h-[48px] shrink-0 items-center border-b px-3 text-sm font-medium">
          Workspace
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3 text-sm text-muted-foreground">
          Mock file tree
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-[48px] shrink-0 items-center border-b px-4">
          <div role="tablist" aria-label="Workbench panels" className="flex items-center gap-1">
            {panels.map((panel) => (
              <button
                key={panel.id}
                type="button"
                role="tab"
                aria-selected={activePanel === panel.id}
                onClick={() => setActivePanel(panel.id)}
                className={cn(
                  'relative flex h-8 items-center gap-1.5 rounded-md px-3 text-sm',
                  activePanel === panel.id
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <panel.icon className="h-4 w-4" aria-hidden />
                {panel.label}
              </button>
            ))}
          </div>
        </header>

        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            data-testid="file-spike-panel"
            aria-hidden={activePanel !== 'file'}
            className={cn(
              'absolute inset-0 min-h-0 min-w-0',
              activePanel === 'file' ? 'z-10' : 'invisible pointer-events-none'
            )}
          >
            <MonacoPanel />
          </div>
          <div
            data-testid="run-spike-panel"
            aria-hidden={activePanel !== 'run'}
            className={cn(
              'absolute inset-0 min-h-0 min-w-0',
              activePanel === 'run' ? 'z-10' : 'invisible pointer-events-none'
            )}
          >
            Run panel
          </div>
          <div
            data-testid="terminal-spike-panel"
            aria-hidden={activePanel !== 'terminal'}
            className={cn(
              'absolute inset-0 min-h-0 min-w-0',
              activePanel === 'terminal' ? 'z-10' : 'invisible pointer-events-none'
            )}
          >
            <TerminalPanel active={activePanel === 'terminal'} />
          </div>
        </main>
      </div>
    </div>
  );
}
