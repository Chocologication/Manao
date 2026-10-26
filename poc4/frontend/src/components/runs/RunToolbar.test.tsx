import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRunSummary } from '@/contracts/run';
import { POC4_RUN_POLICY, SERVICE_RUN_POLICY } from '@/mocks/runFixtures';
import { RunToolbar, type RunToolbarProps } from './RunToolbar';

const NOW = Date.parse('2026-10-26T10:00:00Z');
function toolbar(extra: Partial<RunToolbarProps> = {}) {
  return render(<RunToolbar run={null} projectTemplateId="java-console" statusText="Ready" nowMs={NOW}
    canStart startTitle="Start run" startPending={false} canStop={false} stopWaiting={false}
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
    expect(screen.getByText(/startup limit 1800s.*after ready 7200s/)).toBeVisible();
    expect(screen.getByText(/Expires 2026-10-26T11:59:00Z/)).toBeVisible();
    expect(screen.getByRole('status', { name: 'Run availability' })).toHaveTextContent('Accessible · 1:59:00 left');
    expect(screen.queryByText(/· timeout 1800s/)).not.toBeInTheDocument();
  });

  it('keeps TASK timeout from its own policy even when the project is a web template', () => {
    toolbar({ run: run({ ...POC4_RUN_POLICY, timeoutSeconds: 45 }), projectTemplateId: 'python-fastapi-web' });
    expect(screen.getByText(/timeout 45s/)).toBeVisible();
    expect(screen.queryByText(/after ready/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Expires/)).not.toBeInTheDocument();
  });

  it('does not arm a SERVICE expiry before readiness', () => {
    toolbar({ run: run() });
    expect(screen.getByText(/startup limit 1800s.*after ready 7200s/)).toBeVisible();
    expect(screen.getByRole('status', { name: 'Run availability' })).toHaveTextContent('Starting');
    expect(screen.queryByText(/Expires/)).not.toBeInTheDocument();
  });

  it.each(['java-spring-boot-web', 'python-fastapi-web'] as const)('previews the separate SERVICE limits for %s', projectTemplateId => {
    toolbar({ projectTemplateId });
    expect(screen.getByText(/startup limit 1800s.*after ready 7200s/)).toBeVisible();
    expect(screen.queryByText(/Expires/)).not.toBeInTheDocument();
  });
});
