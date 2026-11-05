import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseTerminalAuditId,
  parseTerminalSessionId,
  type TerminalAuditEntry,
} from '@/contracts/terminal';
import { TerminalAuditView } from './TerminalAuditView';

function audit(
  id: string,
  options: Partial<Omit<TerminalAuditEntry, 'id' | 'sessionId'>> = {},
): TerminalAuditEntry {
  return {
    id: parseTerminalAuditId(id),
    sessionId: parseTerminalSessionId(`session-${id}`),
    command: 'mvn -q -DskipTests compile exec:java',
    state: 'SUCCEEDED',
    startedAt: '2026-08-25T02:00:00.000Z',
    finishedAt: '2026-08-25T02:00:04.000Z',
    exitCode: 0,
    ...options,
  };
}

const baseProps = {
  items: [] as readonly TerminalAuditEntry[],
  isPending: false,
  isError: false,
  errorMessage: null,
  hasNextPage: false,
  isFetchingNextPage: false,
  onLoadMore: vi.fn(),
  onRetry: vi.fn(),
};

afterEach(cleanup);

describe('TerminalAuditView states', () => {
  it('announces the initial loading state without rendering a blank surface', () => {
    render(<TerminalAuditView {...baseProps} isPending />);

    expect(screen.getByRole("status", { name: '正在加载命令记录' })).toHaveTextContent(
      '正在加载命令记录',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('announces errors and exposes a retry command', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <TerminalAuditView
        {...baseProps}
        isError
        errorMessage="无法加载命令记录"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('无法加载命令记录');
    await user.click(screen.getByRole('button', { name: '重试加载命令记录' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('renders a clear empty state after a successful request', () => {
    render(<TerminalAuditView {...baseProps} />);

    expect(screen.getByRole("status", { name: '暂无命令记录' })).toHaveTextContent(
      '本次运行暂无命令记录',
    );
  });
});

describe('TerminalAuditView structured entries', () => {
  it('renders command, state, timestamps, and exit code in a semantic table', () => {
    const running = audit('audit-running', {
      command: 'mvn -q test',
      state: 'RUNNING',
      finishedAt: null,
      exitCode: null,
    });
    const failed = audit('audit-failed', {
      command: 'mvn test -Dtest=FailureTest',
      state: 'FAILED',
      finishedAt: '2026-08-25T02:00:05.000Z',
      exitCode: 1,
    });
    render(<TerminalAuditView {...baseProps} items={[running, failed]} />);

    const table = screen.getByRole('table', { name: '终端命令记录' });
    expect(table).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '命令',
      '状态',
      '开始时间',
      '结束时间',
      '退出码',
    ]);
    expect(screen.getByText('mvn -q test')).toBeInTheDocument();
    expect(screen.getByText('正在执行')).toBeInTheDocument();
    expect(screen.getByText('执行失败')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(table.querySelector('time[datetime="2026-08-25T02:00:00.000Z"]')).not.toBeNull();
  });

  it('renders long or hostile commands as bounded plain text with a full accessible label', () => {
    const hostile = `<img src=x onerror=alert(1)>${'x'.repeat(600)}\n\t\u0000tail`;
    render(<TerminalAuditView {...baseProps} items={[audit('audit-hostile', { command: hostile })]} />);

    const command = screen.getByLabelText(/^命令：<img src=x onerror=alert\(1\)>/);
    expect(command.tagName).toBe('CODE');
    expect(command).toHaveAttribute('title');
    const hasControlCharacter = [...(command.textContent ?? '')].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
    expect(hasControlCharacter).toBe(false);
    expect(command.textContent).toContain('\uFFFD');
    expect(command.closest('td')).toHaveClass('max-w-0');
    expect(document.querySelector('img')).toBeNull();
  });

  it('loads another page once while preserving the current table', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <TerminalAuditView
        {...baseProps}
        items={[audit('audit-page-1')]}
        hasNextPage
        onLoadMore={onLoadMore}
      />,
    );

    const loadMore = screen.getByRole('button', { name: '加载更多命令记录' });
    await user.click(loadMore);
    expect(onLoadMore).toHaveBeenCalledOnce();
    expect(screen.getByRole('table')).toBeInTheDocument();

    rerender(
      <TerminalAuditView
        {...baseProps}
        items={[audit('audit-page-1')]}
        hasNextPage
        isFetchingNextPage
        onLoadMore={onLoadMore}
      />,
    );
    expect(loadMore).toBeDisabled();
    expect(loadMore).toHaveTextContent('正在加载更多');
  });
});
