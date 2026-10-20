import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';
import { useState } from 'react';
import type { ReasoningEffort } from '@/contracts/agentTask';
afterEach(cleanup);
const props = { value: 'high' as const, disabled: false, active: true };
it('maps native values and ticks to all four original efforts', async () => {
  const onChange = vi.fn();
  function ControlledPicker() {
    const [value, setValue] = useState<ReasoningEffort>('high');
    return <ReasoningEffortPicker {...props} value={value} onChange={next => { onChange(next); setValue(next); }} />;
  }
  render(<ControlledPicker />);
  await userEvent.click(screen.getByRole('button', { name: '推理强度 · 高' }));
  const slider = screen.getByRole('slider', { name: '推理强度' });
  expect(slider).toHaveValue('2'); expect(slider).toHaveAttribute('aria-valuetext', '高');
  for (const [index, effort] of ['off', 'low', 'high', 'max'].entries()) {
    fireEvent.change(slider, { target: { value: String(index) } }); expect(onChange).toHaveBeenLastCalledWith(effort);
  }
  for (const [index, label] of ['关闭', '低', '高', '最高'].entries()) {
    await userEvent.click(screen.getByRole('button', { name: label }));
    expect(onChange).toHaveBeenLastCalledWith(['off', 'low', 'high', 'max'][index]);
  }
});
it('returns focus on Escape and dismisses on outside click', async () => {
  render(<><ReasoningEffortPicker {...props} onChange={vi.fn()} /><button>Outside</button></>);
  const trigger = screen.getByRole('button', { name: /推理强度/ });
  await userEvent.click(trigger); await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('slider')).not.toBeInTheDocument()); expect(trigger).toHaveFocus();
  await userEvent.click(trigger); await userEvent.click(screen.getByText('Outside'));
  await waitFor(() => expect(screen.queryByRole('slider')).not.toBeInTheDocument());
});
it.each(['inactive', 'disabled'] as const)('closes when %s without stealing visible page focus', async mode => {
  const onChange = vi.fn();
  const view = render(<><ReasoningEffortPicker {...props} onChange={onChange} /><button>Visible page</button></>);
  await userEvent.click(screen.getByRole('button', { name: /推理强度/ })); screen.getByText('Visible page').focus();
  view.rerender(<><ReasoningEffortPicker {...props} active={mode !== 'inactive'} disabled={mode === 'disabled'} onChange={onChange} /><button>Visible page</button></>);
  await waitFor(() => expect(screen.queryByRole('slider')).not.toBeInTheDocument());
  expect(screen.getByText('Visible page')).toHaveFocus(); expect(onChange).not.toHaveBeenCalled();
});
it('does not open or emit changes when disabled', async () => {
  const onChange = vi.fn(); render(<ReasoningEffortPicker {...props} disabled onChange={onChange} />);
  const trigger = screen.getByRole('button', { name: /推理强度/ });
  expect(trigger).toBeDisabled(); await userEvent.click(trigger);
  expect(screen.queryByRole('slider')).not.toBeInTheDocument(); expect(onChange).not.toHaveBeenCalled();
});
