import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { WorkbenchSpike } from './WorkbenchSpike';

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
});
