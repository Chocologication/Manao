import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRunSummary } from '@/contracts/run';
import { POC4_RUN_POLICY, SERVICE_RUN_POLICY } from '@/mocks/runFixtures';
import { RunToolbar, type RunToolbarProps } from './RunToolbar';

const NOW = Date.parse('2026-10-26T10:00:00Z');
function toolbar(extra: Partial<RunToolbarProps> = {}) {
  return render(<RunToolbar run={null} projectTemplateId="java-console" statusText="已就绪" nowMs={NOW}
    canStart startTitle="启动运行" startPending={false} canStop={false} stopWaiting={false}
    stopPending={false} authorityError={null} startError={null} stopError={null} reloadFailed={false}
    onStart={vi.fn()} onStop={vi.fn()} onRetryAuthority={vi.fn()} onRetryReload={vi.fn()} {...extra} />);
}
function run(policy = SERVICE_RUN_POLICY, extra = {}) {
  return parseRunSummary({ id: 'run-policy', state: 'RUNNING', requestedWorkspaceRevision: '7', policy,
    createdAt: '2026-10-26T09:58:00Z', startedAt: '2026-10-26T09:59:00Z', finishedAt: null,
    terminationReason: null, exitCode: null, logTruncated: false, logEvictedBytes: 0, lastLogSeq: null,
    firstReadyAt: null, expiresAt: null, ...extra });
}
afterEach(cleanup);

describe('RunToolbar policy deadlines', () => {
  it('shows SERVICE startup, ready lifetime and the actual expiry with a positive countdown', () => {
    toolbar({ run: run(SERVICE_RUN_POLICY, { firstReadyAt: '2026-10-26T09:59:00Z', expiresAt: '2026-10-26T11:59:00Z' }) });
    expect(screen.getByText(/启动时限 1800 秒.*就绪后可运行 7200 秒/)).toBeVisible();
    expect(screen.getByText(/到期时间：2026-10-26T11:59:00Z/)).toBeVisible();
    expect(screen.getByRole("status", { name: '服务可用状态' })).toHaveTextContent('可访问 · 剩余 1:59:00');
    expect(screen.queryByText(/· 运行时限 1800 秒/)).not.toBeInTheDocument();
  });

  it('keeps TASK timeout from its own policy even when the project is a web template', () => {
    toolbar({ run: run({ ...POC4_RUN_POLICY, timeoutSeconds: 45 }), projectTemplateId: 'python-fastapi-web' });
    expect(screen.getByText(/运行时限 45 秒/)).toBeVisible();
    expect(screen.queryByText(/就绪后可运行/)).not.toBeInTheDocument();
    expect(screen.queryByText(/到期时间：/)).not.toBeInTheDocument();
  });

  it('does not arm a SERVICE expiry before readiness', () => {
    toolbar({ run: run() });
    expect(screen.getByText(/启动时限 1800 秒.*就绪后可运行 7200 秒/)).toBeVisible();
    expect(screen.getByRole("status", { name: '服务可用状态' })).toHaveTextContent('正在启动');
    expect(screen.queryByText(/到期时间：/)).not.toBeInTheDocument();
  });

  it.each(['java-spring-boot-web', 'python-fastapi-web', 'node-javascript-web', 'node-typescript-web'] as const)('previews the separate SERVICE limits for %s', projectTemplateId => {
    toolbar({ projectTemplateId });
    expect(screen.getByText(/启动时限 1800 秒.*就绪后可运行 7200 秒/)).toBeVisible();
    expect(screen.queryByText(/到期时间：/)).not.toBeInTheDocument();
  });
});
