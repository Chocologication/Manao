import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRunId } from '@/contracts/run';
import { EMPTY_LOG_WINDOW, RunLogStore } from '@/features/logs/RunLogStore';
import { RunLogView } from './RunLogView';

afterEach(cleanup);
function makeStore(text: string) {
  const store = new RunLogStore({ projectId: 'project-a', runId: parseRunId('run-a') });
  const byteLength = new TextEncoder().encode(text).byteLength;
  store.applyReplay([{ seq: 1, text, byteLength, persistedAt: '2026-10-14T10:00:00.000Z' }],
    { ...EMPTY_LOG_WINDOW, firstAvailableSeq: 1, lastAvailableSeq: 1, retainedBytes: byteLength });
  return store;
}

describe('run log search and error actions', () => {
  it('retains context, cycles matches and leaves the original text intact', async () => {
    const user = userEvent.setup();
    const text = 'before\nError: one\nbetween\nERROR: two\nafter';
    const store = makeStore(text);
    const view = render(<RunLogView store={store} />);
    await user.type(screen.getByLabelText('搜索日志'), 'error');
    const log = screen.getByRole('region', { name: 'Run logs' });
    expect(log.querySelector('pre')).toHaveTextContent('before Error: one between ERROR: two after');
    expect(log.querySelectorAll('mark')).toHaveLength(2);
    expect(log.querySelector('[data-active-match="true"]')).toHaveTextContent('Error');
    await user.click(screen.getByRole('button', { name: '下一个命中' }));
    expect(log.querySelector('[data-active-match="true"]')).toHaveTextContent('ERROR');
    await user.click(screen.getByRole('button', { name: '上一个命中' }));
    expect(log.querySelector('[data-active-match="true"]')).toHaveTextContent('Error');
    await user.clear(screen.getByLabelText('搜索日志'));
    expect(log.querySelectorAll('mark')).toHaveLength(0);
    expect(log.querySelector('pre')?.textContent).toBe(text);
    view.unmount(); store.dispose();
  });
  it('bounds highlights without discarding log content', async () => {
    const text = `${'error\n'.repeat(2100)}tail`;
    const store = makeStore(text);
    const view = render(<RunLogView store={store} />);
    await userEvent.setup().type(screen.getByLabelText('搜索日志'), 'error');
    const log = screen.getByRole('region', { name: 'Run logs' });
    expect(log.querySelectorAll('mark')).toHaveLength(2000);
    expect(log.querySelector('pre')?.textContent).toBe(text);
    expect(screen.getByText(/仅高亮前 2000 处/)).toBeInTheDocument();
    view.unmount(); store.dispose();
  });
  it('passes the parsed source position to the existing locator callback', async () => {
    const locate = vi.fn();
    const store = makeStore('File "src/main.py", line 12, in main');
    const view = render(<RunLogView store={store} onLocateError={locate} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'src/main.py:12' }));
    expect(locate).toHaveBeenCalledWith({ path: 'src/main.py', line: 12, source: 'python' });
    view.unmount(); store.dispose();
  });
});
