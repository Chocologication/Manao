import { useCallback, useEffect, useRef } from 'react';
import {
  TerminalSearchBar,
  type TerminalSearchBarProps,
  type TerminalSearchBarRef,
  type TerminalSearchOptions,
} from './TerminalSearchBar';

export type JobTerminalSearchPort = {
  findNext(term: string, options?: TerminalSearchOptions): boolean;
  findPrevious(term: string, options?: TerminalSearchOptions): boolean;
  clearSearch(): void;
  focus(): void;
};

export type JobTerminalSearchProps = {
  active: boolean;
  isOpen: boolean;
  terminal: JobTerminalSearchPort;
  onOpenChange(open: boolean): void;
  theme?: TerminalSearchBarProps['theme'];
};

export function JobTerminalSearch({
  active,
  isOpen,
  terminal,
  onOpenChange,
  theme,
}: JobTerminalSearchProps) {
  const searchRef = useRef<TerminalSearchBarRef>(null);

  const handleClose = useCallback(() => {
    onOpenChange(false);
    terminal.focus();
  }, [onOpenChange, terminal]);

  const findNext = useCallback(
    (term: string, options?: TerminalSearchOptions) => terminal.findNext(term, options),
    [terminal],
  );
  const findPrevious = useCallback(
    (term: string, options?: TerminalSearchOptions) => terminal.findPrevious(term, options),
    [terminal],
  );
  const clearSearch = useCallback(() => terminal.clearSearch(), [terminal]);

  useEffect(() => {
    if (!active) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      if (isOpen) searchRef.current?.focus();
      else onOpenChange(true);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [active, isOpen, onOpenChange]);

  return (
    <TerminalSearchBar
      ref={searchRef}
      isOpen={active && isOpen}
      onClose={handleClose}
      onFindNext={findNext}
      onFindPrevious={findPrevious}
      onClearSearch={clearSearch}
      theme={theme}
    />
  );
}
