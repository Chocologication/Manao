import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ContextUsageIndicator } from './ContextUsageIndicator';

afterEach(cleanup);

it('shows the current context estimate and updates after a new measurement', () => {
  const view = render(<ContextUsageIndicator usage={{ tokens: 262144, contextWindow: 1048576, percent: 25 }} />);
  const meter = screen.getByRole('progressbar', { name: '上下文占用' });
  expect(meter).toHaveAttribute('aria-valuenow', '25');
  expect(meter).toHaveAttribute('aria-valuetext', expect.stringContaining('262,144 / 1,048,576 tokens'));
  expect(screen.getByText('约 25.0%')).toBeVisible();
  expect(meter).toHaveAttribute('aria-valuetext', expect.stringContaining('75%'));
  view.rerender(<ContextUsageIndicator usage={{ tokens: 786432, contextWindow: 1048576, percent: 75 }} />);
  expect(meter).toHaveAttribute('aria-valuenow', '75');
  expect(screen.getByText('约 75.0%')).toBeVisible();
});

it('distinguishes unknown usage after compaction from a measured zero', () => {
  const view = render(<ContextUsageIndicator usage={{ tokens: 0, contextWindow: 1048576, percent: 0 }} />);
  const meter = screen.getByRole('progressbar', { name: '上下文占用' });
  expect(meter).toHaveAttribute('aria-valuenow', '0');
  view.rerender(<ContextUsageIndicator usage={{ tokens: null, contextWindow: 1048576, percent: null }} />);
  expect(meter).not.toHaveAttribute('aria-valuenow');
  expect(screen.getByText('占用暂不可用')).toBeVisible();
  expect(screen.queryByText('约 0.0%')).toBeNull();
  view.rerender(<ContextUsageIndicator usage={null} />);
  expect(meter).not.toHaveAttribute('aria-valuenow');
});

it('caps the visual range while retaining an over-limit estimate in its description', () => {
  render(<ContextUsageIndicator usage={{ tokens: 1101005, contextWindow: 1048576, percent: 105 }} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  expect(screen.getByText('约 105.0%')).toBeVisible();
});
