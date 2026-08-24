import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JobTerminalSearch,
  type JobTerminalSearchPort,
} from './JobTerminalSearch';

afterEach(cleanup);

function createTerminal(found = true): JobTerminalSearchPort {
  return {
    findNext: vi.fn(() => found),
    findPrevious: vi.fn(() => found),
    clearSearch: vi.fn(),
    focus: vi.fn(),
  };
}

function SearchHarness({
  active,
  terminal,
}: {
  active: boolean;
  terminal: JobTerminalSearchPort;
}) {
  const [open, setOpen] = useState(false);
  return (
    <JobTerminalSearch
      active={active}
      isOpen={open}
      terminal={terminal}
      onOpenChange={setOpen}
    />
  );
}

describe('JobTerminalSearch', () => {
  it('opens for Ctrl/Cmd+F only while its panel is active', () => {
    const inactiveTerminal = createTerminal();
    const activeTerminal = createTerminal();
    render(
      <>
        <SearchHarness active={false} terminal={inactiveTerminal} />
        <SearchHarness active terminal={activeTerminal} />
      </>,
    );
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    fireEvent(window, event);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getAllByRole('searchbox', { name: 'Search terminal output' })).toHaveLength(1);
    expect(screen.getByRole('searchbox', { name: 'Search terminal output' })).toHaveFocus();
    expect(inactiveTerminal.focus).not.toHaveBeenCalled();
  });

  it('ignores the shortcut while inactive and accepts the Meta-key variant after activation', () => {
    const terminal = createTerminal();
    const view = render(<SearchHarness active={false} terminal={terminal} />);
    const inactiveEvent = new KeyboardEvent('keydown', {
      key: 'F',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, inactiveEvent);
    expect(inactiveEvent.defaultPrevented).toBe(false);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();

    view.rerender(<SearchHarness active terminal={terminal} />);
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(screen.getByRole('searchbox', { name: 'Search terminal output' })).toBeInTheDocument();
  });

  it('exposes labelled toggles and announces a no-result search', async () => {
    const user = userEvent.setup();
    const terminal = createTerminal(false);
    render(<SearchHarness active terminal={terminal} />);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    const caseButton = screen.getByRole('button', { name: 'Match case' });
    const wordButton = screen.getByRole('button', { name: 'Match whole word' });
    const regexButton = screen.getByRole('button', { name: 'Use regular expression' });
    expect(caseButton).toHaveAttribute('aria-pressed', 'false');
    expect(wordButton).toHaveAttribute('aria-pressed', 'false');
    expect(regexButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(caseButton);
    await user.click(wordButton);
    await user.click(regexButton);
    await user.type(screen.getByRole('searchbox', { name: 'Search terminal output' }), 'missing');

    expect(caseButton).toHaveAttribute('aria-pressed', 'true');
    expect(wordButton).toHaveAttribute('aria-pressed', 'true');
    expect(regexButton).toHaveAttribute('aria-pressed', 'true');
    expect(terminal.findNext).toHaveBeenLastCalledWith('missing', {
      caseSensitive: true,
      wholeWord: true,
      regex: true,
    });
    expect(screen.getByRole('status')).toHaveTextContent('No results');
  });

  it('searches backward and restores xterm focus on Escape from any search control', async () => {
    const user = userEvent.setup();
    const terminal = createTerminal();
    render(<SearchHarness active terminal={terminal} />);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const input = screen.getByRole('searchbox', { name: 'Search terminal output' });
    await user.type(input, 'compile');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(terminal.findPrevious).toHaveBeenCalledWith('compile', {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });

    vi.mocked(terminal.clearSearch).mockClear();
    await user.click(screen.getByRole('button', { name: 'Match case' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(terminal.clearSearch).toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalledOnce();
  });
});
