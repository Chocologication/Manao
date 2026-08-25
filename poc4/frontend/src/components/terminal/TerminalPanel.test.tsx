import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalPanel } from './TerminalPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Stage 0 TerminalPanel shared search', () => {
  it('handles active Ctrl/Cmd+F and Escape and cleans up each window listener', () => {
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const view = render(<TerminalPanel active />);
    const firstListener = addListener.mock.calls.find((call) => call[0] === 'keydown')?.[1];
    expect(firstListener).toBeTypeOf('function');

    const ctrlFind = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, ctrlFind);
    expect(ctrlFind.defaultPrevented).toBe(true);
    const searchbox = screen.getByRole('searchbox', { name: 'Search terminal output' });

    fireEvent.keyDown(searchbox, { key: 'Escape' });
    expect(screen.queryByRole('searchbox', { name: 'Search terminal output' })).not.toBeInTheDocument();

    view.rerender(<TerminalPanel active={false} />);
    expect(removeListener).toHaveBeenCalledWith('keydown', firstListener);
    const inactiveMetaFind = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, inactiveMetaFind);
    expect(inactiveMetaFind.defaultPrevented).toBe(false);

    view.rerender(<TerminalPanel active />);
    const activeMetaFind = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, activeMetaFind);
    expect(activeMetaFind.defaultPrevented).toBe(true);
    expect(screen.getByRole('searchbox', { name: 'Search terminal output' })).toBeInTheDocument();

    const activeListeners = addListener.mock.calls.filter((call) => call[0] === 'keydown');
    const latestListener = activeListeners.at(-1)?.[1];
    view.unmount();
    expect(removeListener).toHaveBeenCalledWith('keydown', latestListener);
  });
});
