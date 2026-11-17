import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient } from '../../app/appRuntime';
import { server } from '../../mocks/node';
import { resetAppRuntime } from '../../test/renderApp';
import { MyRunSharesPage } from './MyRunSharesPage';

const owner = { id: 's1', title: '来源已删除的结果', sourceProjectName: '已删除的项目', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), status: 'ACTIVE', sharePath: `/shares/${'a'.repeat(43)}` };
function login(id = 'alice') { authSession.authenticate({ accessToken: crypto.randomUUID(), expiresAt: new Date(Date.now() + 3600000).toISOString(), user: { id, username: id, email: null, emailVerified: false } }); }
function show() { return render(<AppProviders><MemoryRouter><MyRunSharesPage /></MemoryRouter></AppProviders>); }
beforeEach(() => { resetAppRuntime(); login(); }); afterEach(() => { cleanup(); resetAppRuntime(); });
describe('MyRunSharesPage', () => {
  it('manages independent owner records after source deletion, pages and revokes active entries', async () => {
    let revoked = false; const cursors: (string | null)[] = [];
    server.use(http.get('/api/v1/run-shares', ({ request }) => { const before = new URL(request.url).searchParams.get('before'); cursors.push(before); return HttpResponse.json(before ? { items: [{ ...owner, id: 's2', title: '到期的结果', status: 'EXPIRED', sharePath: null }], nextCursor: null } : { items: [revoked ? { ...owner, status: 'REVOKED', sharePath: null } : owner], nextCursor: 'cursor+/=' }); }), http.delete('/api/v1/run-shares/s1', () => { revoked = true; return new HttpResponse(null, { status: 204 }); }));
    show(); await screen.findByText('来源已删除的结果'); expect(screen.getByText('已删除的项目')).toBeInTheDocument(); await userEvent.setup().click(screen.getByRole('button', { name: '加载更多' })); await screen.findByText('到期的结果'); expect(cursors).toContain('cursor+/=');
    await userEvent.setup().click(screen.getByRole('button', { name: '撤销分享' })); await screen.findByText('已撤销'); expect(screen.queryByRole('button', { name: '撤销分享' })).toBeNull(); expect(queryClient.getQueryCache().getAll().some(q => q.queryKey[0] === 'run-shares' && q.queryKey[1] === 'alice')).toBe(true);
  });
  it('does not leak old records or late responses across owner changes or same-owner re-login', async () => {
    let release = () => { }; let reads = 0; const gate = new Promise<void>(r => { release = r; }); server.use(http.get('/api/v1/run-shares', async () => { if (++reads === 1) { await gate; return HttpResponse.json({ items: [owner], nextCursor: null }); } return HttpResponse.json({ items: [], nextCursor: null }); }));
    show(); await waitFor(() => expect(reads).toBe(1)); act(() => login()); await act(async () => { release(); await gate; }); await screen.findByText('暂无分享'); expect(screen.queryByText('来源已删除的结果')).toBeNull(); act(() => login('bob')); await screen.findByText('暂无分享'); expect(screen.queryByText('来源已删除的结果')).toBeNull();
  });
  it('shows empty and retryable error states', async () => {
    let calls = 0; server.use(http.get('/api/v1/run-shares', () => ++calls === 1 ? HttpResponse.error() : HttpResponse.json({ items: [], nextCursor: null }))); show(); await screen.findByRole('button', { name: '重试' }); await userEvent.setup().click(screen.getByRole('button', { name: '重试' })); await screen.findByText('暂无分享'); expect(calls).toBe(2);
  });
});
