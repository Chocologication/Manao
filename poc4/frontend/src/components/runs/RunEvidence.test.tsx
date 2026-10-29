import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '@/api/authApi';
import { listDirectory } from '@/api/fileApi';
import { getRun, listRuns, startRun } from '@/api/runApi';
import { AppProviders } from '@/app/AppProviders';
import { authSession, queryClient } from '@/app/appRuntime';
import { parseProjectDirectoryPath } from '@/features/files/pathPolicy';
import { resetAppRuntime } from '@/test/renderApp';
import { ALICE_SEED_PROJECT_ID } from '@/mocks/state';
import { ActivityCenter } from '@/components/shell/ActivityCenter';
import { RunInsights } from './RunInsights';

const project = {
  id: ALICE_SEED_PROJECT_ID, name: 'Alice Notebook', state: 'READY' as const,
  createdAt: '2026-08-21T00:00:00.000Z', failureReason: null,
};
const storageKey = `manao.activity-read.v1:usr-alice:${project.id}`;

async function createFinishedRun() {
  const tree = await listDirectory(project.id, parseProjectDirectoryPath(''));
  const created = await startRun(project.id, { expectedWorkspaceRevision: tree.workspaceRevision });
  await waitFor(async () => expect((await getRun(project.id, created.id)).state).toBe('SUCCEEDED'));
  return getRun(project.id, created.id);
}

beforeEach(async () => {
  resetAppRuntime();
  localStorage.removeItem(storageKey);
  localStorage.removeItem(`${storageKey}:cleared-through`);
  authSession.authenticate(await login({ username: 'alice', password: 'demo-pass' }));
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
  localStorage.removeItem(storageKey);
  localStorage.removeItem(`${storageKey}:cleared-through`);
});

describe('Run evidence surfaces', () => {
  it('marks activity read and clears local notifications without removing server history', async () => {
    const run = await createFinishedRun();
    const user = userEvent.setup();
    render(<AppProviders><ActivityCenter projectId={project.id} userId="usr-alice" onOpenRuns={vi.fn()} /></AppProviders>);
    await user.click(await screen.findByRole('button', { name: '运行活动，有 1 条未读' }));
    await user.click(screen.getByRole('button', { name: '全部标为已读' }));
    expect(screen.getByRole('button', { name: '运行活动' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKey) ?? '[]')).toContain(run.id);
    await user.click(screen.getByRole('button', { name: '清空本地运行通知' }));
    expect(screen.getByText('暂无新的运行活动')).toBeInTheDocument();
    expect((await listRuns(project.id, null)).items.map((item) => item.id)).toContain(run.id);
  });

  it('keeps completed run evidence visible with no active Run and hides the AI diagnostic placeholder', async () => {
    const run = await createFinishedRun();
    render(<AppProviders><MemoryRouter><RunInsights project={project} activeRun={null} activePending={false} activeError={false} writesLocked={false} compactViewport={false} onOpenRuns={vi.fn()} onClose={vi.fn()} /></MemoryRouter></AppProviders>);
    expect(await screen.findByText(run.id)).toBeInTheDocument();
    expect(screen.getByText(run.policy.command)).toBeInTheDocument();
    expect(screen.getByText(run.requestedWorkspaceRevision)).toBeInTheDocument();
    expect(screen.queryByLabelText('AI 诊断预览')).not.toBeInTheDocument();
    expect(screen.getByText(/不代表后端实时阶段事件/)).toBeInTheDocument();
  });
});
