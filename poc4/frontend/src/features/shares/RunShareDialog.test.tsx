import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/AppProviders';
import { authSession } from '../../app/appRuntime';
import { server } from '../../mocks/node';
import { resetAppRuntime } from '../../test/renderApp';
import { RunShareDialog } from './RunShareDialog';
import { QRCodeSVG } from 'qrcode.react';
import { renderToStaticMarkup } from 'react-dom/server';

const owner = { id: 'share-1', title: '原有标题', sourceProjectName: '已删除的项目', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 259200000).toISOString(), status: 'ACTIVE', sharePath: `/shares/${'a'.repeat(43)}` };
const snapshot = { run: { state: 'FAILED', exitCode: null, createdAt: owner.createdAt, startedAt: null, finishedAt: owner.createdAt, language: 'python', runtimeLabel: 'Python 3.13 / uv' }, logText: '<b>plain log</b>\n' };
const preview = { kind: 'PREVIEW', snapshot, snapshotDigest: 'a'.repeat(64), share: null };
function authenticate() { authSession.authenticate({ accessToken: crypto.randomUUID(), expiresAt: new Date(Date.now() + 3600000).toISOString(), user: { id: 'owner-1', username: 'alice', email: null, emailVerified: false } }); }
function show() { return render(<AppProviders><RunShareDialog projectId="p" runId="r" onClose={() => { }} /></AppProviders>); }
beforeEach(() => { resetAppRuntime(); authenticate(); server.use(http.get('/api/v1/projects/p/runs/r/share-preview', () => HttpResponse.json(preview))); });
afterEach(() => { cleanup(); resetAppRuntime(); vi.restoreAllMocks(); });
async function fill() { const user = userEvent.setup(); const title = await screen.findByLabelText('分享标题'); await user.clear(title); await user.type(title, '我的结果'); await user.type(screen.getByLabelText('分享说明'), '运行说明'); return user; }

describe('RunShareDialog', () => {
  it('prefills the default title and permits publishing without editing it', async () => {
    const bodies: unknown[] = [];
    server.use(http.post('/api/v1/projects/p/runs/r/shares', async ({ request }) => { bodies.push(await request.json()); return HttpResponse.json(owner, { status: 201 }); }));
    show();
    expect(await screen.findByLabelText('分享标题')).toHaveValue('运行结果');
    expect(screen.getByRole('button', { name: '生成分享链接' })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole('button', { name: '生成分享链接' }));
    await screen.findByRole('button', { name: '复制链接' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ title: '运行结果', description: '' });
  });
  it('previews plaintext and null exit, then publishes only after explicit confirmation', async () => {
    const bodies: unknown[] = []; server.use(http.post('/api/v1/projects/p/runs/r/shares', async ({ request }) => { bodies.push(await request.json()); return HttpResponse.json(owner, { status: 201 }); }));
    show(); const user = await fill();
    expect(screen.getByText('<b>plain log</b>')).toBeInTheDocument(); expect(screen.getByText('未产生退出码')).toBeInTheDocument(); expect(document.querySelector('b')).toBeNull();
    expect(bodies).toHaveLength(0); await user.click(screen.getByRole('button', { name: '生成分享链接' })); await screen.findByRole('button', { name: '复制链接' });
    expect(Object.keys(bodies[0] as object).sort()).toEqual(['description', 'requestId', 'snapshotDigest', 'title']); expect(bodies[0]).toMatchObject({ title: '我的结果', description: '运行说明', snapshotDigest: 'a'.repeat(64) });
  });
  it('opens an existing link directly in management and revokes it', async () => {
    let deleted = false; server.use(http.get('/api/v1/projects/p/runs/r/share-preview', () => HttpResponse.json({ kind: 'EXISTING', snapshot: null, snapshotDigest: null, share: owner })), http.delete('/api/v1/run-shares/share-1', () => { deleted = true; return new HttpResponse(null, { status: 204 }); }));
    show(); await screen.findByText('原有标题'); expect(screen.queryByLabelText('分享标题')).toBeNull(); await userEvent.setup().click(screen.getByRole('button', { name: '撤销分享' })); await screen.findByText('已撤销'); expect(deleted).toBe(true);
  });
  it('refreshes changed preview while retaining inputs and requires another click with a new request id', async () => {
    const bodies: Record<string, string>[] = []; let reads = 0;
    server.use(http.get('/api/v1/projects/p/runs/r/share-preview', () => HttpResponse.json(++reads === 1 ? preview : { ...preview, snapshot: { ...snapshot, logText: 'new server log' }, snapshotDigest: 'b'.repeat(64) })), http.post('/api/v1/projects/p/runs/r/shares', async ({ request }) => { bodies.push(await request.json() as Record<string, string>); return bodies.length === 1 ? HttpResponse.json({ code: 'RUN_SHARE_PREVIEW_CHANGED', message: 'changed', traceId: 't' }, { status: 409 }) : HttpResponse.json(owner); }));
    show(); const user = await fill(); await user.click(screen.getByRole('button', { name: '生成分享链接' })); await screen.findByText('new server log');
    expect(screen.getByLabelText('分享标题')).toHaveValue('我的结果'); expect(screen.getByLabelText('分享说明')).toHaveValue('运行说明'); expect(bodies).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '生成分享链接' })); await screen.findByRole('button', { name: '复制链接' }); expect(bodies[1]?.snapshotDigest).toBe('b'.repeat(64)); expect(bodies[1]?.requestId).not.toBe(bodies[0]?.requestId);
  });
  it('manually recovers an uncertain response with the identical immutable body and fixed endpoint', async () => {
    const bodies: unknown[] = []; server.use(http.post('/api/v1/projects/p/runs/r/shares', async ({ request }) => { bodies.push(await request.json()); return bodies.length === 1 ? HttpResponse.error() : HttpResponse.json(owner); }));
    show(); const user = await fill(); await user.click(screen.getByRole('button', { name: '生成分享链接' })); await screen.findByRole('button', { name: '找回原结果' }); expect(bodies).toHaveLength(1);
    expect(screen.getByLabelText('分享标题')).toBeDisabled(); await user.click(screen.getByRole('button', { name: '找回原结果' })); await screen.findByRole('button', { name: '复制链接' }); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  });
  it('does not display a late publish response after the same owner signs in again', async () => {
    let release = () => { }; const gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    server.use(http.post('/api/v1/projects/p/runs/r/shares', async () => { entered = true; await gate; return HttpResponse.json(owner); }));
    show(); const user = await fill(); await user.click(screen.getByRole('button', { name: '生成分享链接' })); await waitFor(() => expect(entered).toBe(true)); act(() => authenticate()); await act(async () => { release(); await gate; });
    await waitFor(() => expect(screen.queryByText('原有标题')).toBeNull()); expect(screen.queryByRole('button', { name: '复制链接' })).toBeNull();
  });
  it('keeps a selectable same-origin URL and matching QR when clipboard fails', async () => {
    server.use(http.get('/api/v1/projects/p/runs/r/share-preview', () => HttpResponse.json({ kind: 'EXISTING', snapshot: null, snapshotDigest: null, share: owner })));
    show(); const field = await screen.findByLabelText('分享链接'); expect(field).toHaveValue(`${window.location.origin}${owner.sharePath}`); expect(screen.getByTitle('运行结果分享二维码').closest('svg')).toBeInTheDocument();
    const expected = new DOMParser().parseFromString(renderToStaticMarkup(<QRCodeSVG value={`${window.location.origin}/shares/${'a'.repeat(43)}`} size={192} marginSize={4} />), 'text/html');
    expect([...screen.getByTitle('运行结果分享二维码').closest('svg')!.querySelectorAll('path')].map(path => path.getAttribute('d'))).toEqual([...expected.querySelectorAll('path')].map(path => path.getAttribute('d')));
    const user = userEvent.setup(); vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied')); await user.click(screen.getByRole('button', { name: '复制链接' })); await screen.findByText('复制失败，请选择链接手动复制'); expect(field).toBeEnabled();
  });
  it('requires new confirmation after a failed preview refresh is manually recovered', async () => {
    let reads = 0; let posts = 0;
    server.use(
      http.get('/api/v1/projects/p/runs/r/share-preview', () => ++reads === 2 ? HttpResponse.error() : HttpResponse.json(reads === 1 ? preview : { ...preview, snapshotDigest: 'b'.repeat(64), snapshot: { ...snapshot, logText: 'recovered preview' } })),
      http.post('/api/v1/projects/p/runs/r/shares', () => { posts++; return HttpResponse.json({ code: 'RUN_SHARE_PREVIEW_CHANGED', message: 'changed', traceId: 't' }, { status: 409 }); }),
    );
    show(); const user = await fill(); await user.click(screen.getByRole('button', { name: '生成分享链接' }));
    await user.click(await screen.findByRole('button', { name: '重试预览' })); await screen.findByText('recovered preview');
    expect(screen.getByLabelText('分享标题')).toHaveValue('我的结果'); expect(screen.getByLabelText('分享标题')).toBeEnabled();
    expect(screen.getByRole('button', { name: '生成分享链接' })).toBeEnabled(); expect(posts).toBe(1);
  });
  it('switches an already-active conflict into existing management without overwriting its title', async () => {
    let reads = 0; let posts = 0;
    server.use(http.get('/api/v1/projects/p/runs/r/share-preview', () => HttpResponse.json(++reads === 1 ? preview : { kind: 'EXISTING', snapshot: null, snapshotDigest: null, share: owner })), http.post('/api/v1/projects/p/runs/r/shares', () => { posts++; return HttpResponse.json({ code: 'RUN_SHARE_ALREADY_ACTIVE', message: 'active', traceId: 't' }, { status: 409 }); }));
    show(); const user = await fill(); await user.click(screen.getByRole('button', { name: '生成分享链接' })); await screen.findByText('原有标题'); expect(screen.queryByLabelText('分享标题')).toBeNull(); expect(posts).toBe(1);
  });
  it('disables repeated confirmation and closing while publish is pending', async () => {
    let release = () => { }; let posts = 0; const gate = new Promise<void>(resolve => { release = resolve; });
    server.use(http.post('/api/v1/projects/p/runs/r/shares', async () => { posts++; await gate; return HttpResponse.json(owner); }));
    const close = vi.fn(); render(<AppProviders><RunShareDialog projectId="p" runId="r" onClose={close} /></AppProviders>);
    const user = await fill(); await user.dblClick(screen.getByRole('button', { name: '生成分享链接' })); await waitFor(() => expect(posts).toBe(1));
    expect(screen.getByRole('button', { name: '正在生成…' })).toBeDisabled(); expect(screen.getByRole('button', { name: '关闭分享弹窗' })).toBeDisabled(); fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(close).not.toHaveBeenCalled();
    await act(async () => { release(); await gate; }); await screen.findByRole('button', { name: '复制链接' }); fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
  });
  it.each([['SOME_UNKNOWN_CODE', 409], ['RUN_SHARE_PREVIEW_CHANGED', 500]] as const)('retains the original key and body for uncertain %s / %s responses', async (code, status) => {
    const bodies: unknown[] = [];
    server.use(http.post('/api/v1/projects/p/runs/r/shares', async ({ request }) => { bodies.push(await request.json()); return bodies.length === 1 ? HttpResponse.json({ code, message: 'unknown', traceId: 't' }, { status }) : HttpResponse.json(owner); }));
    show(); const user = await fill(); await user.click(screen.getByRole('button', { name: '生成分享链接' })); await user.click(await screen.findByRole('button', { name: '找回原结果' })); await screen.findByRole('button', { name: '复制链接' }); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  });
});
