import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkbenchSpike } from './WorkbenchSpike';

afterEach(() => cleanup());

describe('WorkbenchSpike', () => {
  it('keeps only the POC4 panels and switches the active panel', async () => {
    const user = userEvent.setup();
    render(<WorkbenchSpike />);

    expect(screen.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: /Agent|VSC|Git|Worktree/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('run-spike-panel')).toBeVisible();
  });

  it('keeps inactive panels mounted and hidden', async () => {
    const user = userEvent.setup();
    const view = render(<WorkbenchSpike />);

    expect(view.getByTestId('file-spike-panel')).toHaveAttribute('aria-hidden', 'false');
    expect(view.getByTestId('run-spike-panel')).toBeInTheDocument();
    expect(view.getByTestId('run-spike-panel')).toHaveAttribute('aria-hidden', 'true');
    expect(view.getByTestId('run-spike-panel')).toHaveClass('invisible');
    expect(view.getByTestId('terminal-spike-panel')).toBeInTheDocument();
    expect(view.getByTestId('terminal-spike-panel')).toHaveAttribute('aria-hidden', 'true');

    await user.click(view.getByRole('tab', { name: 'Run' }));
    expect(view.getByTestId('file-spike-panel')).toBeInTheDocument();
    expect(view.getByTestId('file-spike-panel')).toHaveAttribute('aria-hidden', 'true');
    expect(view.getByTestId('file-spike-panel')).toHaveClass('invisible');
    expect(view.getByTestId('run-spike-panel')).toHaveAttribute('aria-hidden', 'false');
    expect(view.getByTestId('run-spike-panel')).not.toHaveClass('invisible');
    expect(view.getByTestId('run-spike-panel')).toBeVisible();
  });
});
