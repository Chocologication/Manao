import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TerminalSession, type TerminalAdapter } from '@/terminal/TerminalSession';
import { WebSocketTerminalTransport } from '@/terminal/WebSocketTerminalTransport';
import { TerminalSearchBar } from './TerminalSearchBar';
import '@xterm/xterm/css/xterm.css';

const TERMINAL_URL = 'ws://127.0.0.1:4174/terminal';
const terminalTheme = { background: '#1e1e1e', foreground: '#d4d4d4' };

type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

function createXtermAdapter(terminal: Terminal): TerminalAdapter {
  return {
    open(container) {
      terminal.open(container);
    },
    write(data) {
      terminal.write(data);
    },
    onData(listener) {
      return terminal.onData(listener);
    },
    getSize() {
      return { cols: terminal.cols, rows: terminal.rows };
    },
    dispose() {
      terminal.dispose();
    },
  };
}

export function TerminalPanel({ active }: { active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('disconnected');
  const [lastOutput, setLastOutput] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const teardown = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    fitAddonRef.current = null;
    searchAddonRef.current = null;
    terminalRef.current = null;
    sessionRef.current?.dispose();
    sessionRef.current = null;
  }, []);

  const handleDisconnect = useCallback(() => {
    teardown();
    setSearchOpen(false);
    setStatus('disconnected');
  }, [teardown]);

  const handleConnect = useCallback(() => {
    if (sessionRef.current || !containerRef.current) return;
    const container = containerRef.current;
    setStatus('connecting');
    setLastOutput('');

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      convertEol: true,
      fontSize: 14,
      theme: terminalTheme,
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);

    const transport = new WebSocketTerminalTransport(TERMINAL_URL);
    const decoder = new TextDecoder();
    transport.onOutput((data) => {
      setLastOutput(decoder.decode(data));
    });
    transport.onControl((control) => {
      if (control.type === 'terminal.ready') {
        const activeFit = fitAddonRef.current;
        const activeTerminal = terminalRef.current;
        const activeSession = sessionRef.current;
        if (activeFit && activeTerminal && activeSession) {
          activeFit.fit();
          activeSession.resize(activeTerminal.cols, activeTerminal.rows);
        }
        setStatus('connected');
      }
      if (control.type === 'terminal.error') {
        teardown();
        setStatus('error');
      }
      if (control.type === 'terminal.exit') {
        teardown();
        setStatus('disconnected');
      }
    });
    transport.onError(() => {
      teardown();
      setStatus('error');
    });
    transport.onClose(() => {
      teardown();
      setStatus('disconnected');
    });

    const session = new TerminalSession(createXtermAdapter(terminal), transport);
    sessionRef.current = session;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    terminalRef.current = terminal;
    session.open(container);

    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // Continue with the default renderer.
    }

    fitAddon.fit();
    session.resize(terminal.cols, terminal.rows);

    const observer = new ResizeObserver(() => {
      const activeSession = sessionRef.current;
      const activeFit = fitAddonRef.current;
      const activeTerminal = terminalRef.current;
      if (!activeSession || !activeFit || !activeTerminal) return;
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      activeFit.fit();
      activeSession.resize(activeTerminal.cols, activeTerminal.rows);
    });
    observer.observe(container);
    observerRef.current = observer;
  }, [teardown]);

  const findNext = useCallback(
    (term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }) =>
      searchAddonRef.current?.findNext(term, options) ?? false,
    []
  );
  const findPrevious = useCallback(
    (term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }) =>
      searchAddonRef.current?.findPrevious(term, options) ?? false,
    []
  );
  const clearSearch = useCallback(() => {
    searchAddonRef.current?.clearDecorations();
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);

  useEffect(() => () => teardown(), [teardown]);

  const canConnect = status === 'disconnected' || status === 'error';
  const canDisconnect = status === 'connecting' || status === 'connected';

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Button
          size="xs"
          variant="outline"
          aria-label="Connect terminal"
          disabled={!canConnect}
          onClick={handleConnect}
        >
          Connect
        </Button>
        <Button
          size="xs"
          variant="outline"
          aria-label="Disconnect terminal"
          disabled={!canDisconnect}
          onClick={handleDisconnect}
        >
          Disconnect
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden" style={{ backgroundColor: terminalTheme.background }}>
        <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden" />
        <TerminalSearchBar
          isOpen={searchOpen}
          onClose={() => setSearchOpen(false)}
          onFindNext={findNext}
          onFindPrevious={findPrevious}
          onClearSearch={clearSearch}
          theme={terminalTheme}
        />
      </div>
      <div data-testid="terminal-last-output" className="sr-only">
        {lastOutput}
      </div>
    </div>
  );
}
