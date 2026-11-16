import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../mocks/node';
import { authSession, queryClient } from '../../app/appRuntime';
import { resetAppRuntime } from '../../test/renderApp';
import { PublicRunSharePage } from './PublicRunSharePage';

const token = 'a'.repeat(43), other = 'b'.repeat(43);
function payload(logText = 'public log', expiresAt = new Date(Date.now() + 3600000).toISOString()) { return { title: '<b>结果</b>', description: '**说明**', createdAt: new Date().toISOString(), expiresAt, snapshot: { run: { state: 'SUCCEEDED', exitCode: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, language: 'java', runtimeLabel: 'Java 17 / Maven 3' }, logText } }; }
function Navigation() { const navigate = useNavigate(); return <><button onClick={() => navigate(`/shares/${other}`)}>另一个链接</button><button onClick={() => navigate('/away')}>离开</button></>; }
function show() { return render(<MemoryRouter initialEntries={[`/shares/${token}`]}><Navigation /><Routes><Route path="/shares/:token" element={<PublicRunSharePage />} /><Route path="/away" element={<main>away</main>} /></Routes></MemoryRouter>); }
beforeEach(() => resetAppRuntime()); afterEach(() => { cleanup(); vi.useRealTimers(); resetAppRuntime(); vi.restoreAllMocks(); });
describe('PublicRunSharePage', () => {
  it('renders anonymous plaintext and empty logs without any project/runtime request or persistent cache', async () => {
    server.use(http.get('/api/v1/public/run-shares/:token', ({ request }) => { expect(request.headers.get('Authorization')).toBeNull(); return HttpResponse.json(payload('')); }));
    show(); await screen.findByText('暂无可分享的日志'); expect(screen.getByText('<b>结果</b>')).toBeInTheDocument(); expect(screen.getByText('**说明**')).toBeInTheDocument(); expect(screen.getByText('未产生退出码')).toBeInTheDocument(); expect(document.querySelector('b')).toBeNull(); expect(queryClient.getQueryCache().getAll()).toHaveLength(0); expect(localStorage.length).toBe(0);
  });
  it('preserves all 5 MiB of text in one scrolling log container', async () => {
    const text = 'x'.repeat(5 * 1024 * 1024); server.use(http.get('/api/v1/public/run-shares/:token', () => HttpResponse.json(payload(text)))); show(); await screen.findByRole('region', { name: '运行日志' }); await waitFor(() => expect(screen.getByRole('region', { name: '运行日志' }).textContent).toHaveLength(5 * 1024 * 1024)); expect(screen.getByRole('region', { name: '运行日志' }).tagName).toBe('PRE');
  });
  it('synchronously drops old token content and ignores its late response', async () => {
    let release = () => { }; const gate = new Promise<void>(r => { release = r; }); server.use(http.get('/api/v1/public/run-shares/:token', async ({ params }) => { if (params.token === other) { await gate; return HttpResponse.json(payload('new content')); } return HttpResponse.json(payload('old content')); }));
    show(); await screen.findByText('old content'); await userEvent.setup().click(screen.getByRole('button', { name: '另一个链接' })); expect(screen.queryByText('old content')).toBeNull(); await act(async () => { release(); await gate; }); await screen.findByText('new content'); await userEvent.setup().click(screen.getByRole('button', { name: '离开' })); expect(screen.queryByText('new content')).toBeNull(); expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
  it('hides and drops content at the absolute expiry time', async () => {
    const expires = Date.now() + 1500; server.use(http.get('/api/v1/public/run-shares/:token', () => HttpResponse.json(payload('expires soon', new Date(expires).toISOString())))); show(); await screen.findByText('expires soon'); await waitFor(() => expect(screen.queryByText('expires soon')).toBeNull(), { timeout: 2500 }); expect(screen.getByText('分享已过期')).toBeInTheDocument();
  });
  it('ignores a pending old-token response after the new token has loaded', async () => {
    let release = () => { }; let entered = false; const gate = new Promise<void>(resolve => { release = resolve; });
    server.use(http.get('/api/v1/public/run-shares/:token', async ({ params }) => { if (params.token === token) { entered = true; await gate; return HttpResponse.json(payload('stale secret')); } return HttpResponse.json(payload('current result')); }));
    show(); await waitFor(() => expect(entered).toBe(true)); await userEvent.setup().click(screen.getByRole('button', { name: '另一个链接' })); await screen.findByText('current result');
    await act(async () => { release(); await gate; }); expect(screen.queryByText('stale secret')).toBeNull(); expect(screen.getByText('current result')).toBeInTheDocument();
  });
  it('does not render an already-expired payload even when the transport reports success', async () => {
    server.use(http.get('/api/v1/public/run-shares/:token', () => HttpResponse.json(payload('expired body', new Date(Date.now() - 1).toISOString())))); show(); await screen.findByText('分享已过期'); expect(screen.queryByText('expired body')).toBeNull(); expect(screen.queryByRole('region', { name: '运行日志' })).toBeNull();
  });
  it.each([['RUN_SHARE_EXPIRED', '分享已过期', 410], ['RUN_SHARE_REVOKED', '分享已撤销', 410], ['RUN_SHARE_NOT_FOUND', '分享不存在', 404]] as const)('shows %s without clearing a signed-in account', async (code, message, status) => {
    authSession.authenticate({ accessToken: 'token', expiresAt: new Date(Date.now() + 3600000).toISOString(), user: { id: 'a', username: 'alice', email: null, emailVerified: false } }); server.use(http.get('/api/v1/public/run-shares/:token', ({ request }) => { expect(request.headers.has('Authorization')).toBe(false); return HttpResponse.json({ code, message, traceId: 't' }, { status }); })); show(); await screen.findByText(message); expect(authSession.getSnapshot().status).toBe('authenticated');
  });
  it('retries a network failure only when requested', async () => {
    let calls = 0; server.use(http.get('/api/v1/public/run-shares/:token', () => ++calls === 1 ? HttpResponse.error() : HttpResponse.json(payload()))); show(); await screen.findByRole('button', { name: '重试' }); expect(calls).toBe(1); await userEvent.setup().click(screen.getByRole('button', { name: '重试' })); await screen.findByText('public log'); expect(calls).toBe(2);
  });
});
