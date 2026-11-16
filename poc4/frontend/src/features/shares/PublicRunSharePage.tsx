import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { ApiRequestError } from '../../api/ApiRequestError';
import { getPublicRunShare } from '../../api/runShareApi';
import { Button } from '../../components/ui/button';
import type { PublicShare } from '../../contracts/runShare';
import { RunShareContent, shareTime } from './RunShareContent';

type PageState = { kind: 'loading' } | { kind: 'ready'; share: PublicShare } | { kind: 'error'; message: string; retryable: boolean };
export function PublicRunSharePage() { const { token = '' } = useParams(); return <PublicShareToken key={token} token={token} />; }
function PublicShareToken({ token }: { token: string }) {
  const [state, setState] = useState<PageState>({ kind: 'loading' }); const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let live = true; let timer: ReturnType<typeof setTimeout> | undefined;
    let expiresAt = 0;
    function expire() { if (!live) return; const remaining = expiresAt - Date.now(); if (remaining <= 0) setState({ kind: 'error', message: '分享已过期', retryable: false }); else timer = setTimeout(expire, Math.min(remaining, 2147483647)); }
    function visible() { if (document.visibilityState === 'visible' && expiresAt > 0 && expiresAt <= Date.now()) { if (timer) clearTimeout(timer); expire(); } }
    setState({ kind: 'loading' });
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) setState({ kind: 'error', message: '分享不存在', retryable: false });
    else void getPublicRunShare(token, controller.signal).then(share => { if (!live) return; expiresAt = Date.parse(share.expiresAt); if (expiresAt <= Date.now()) { expire(); return; } setState({ kind: 'ready', share }); expire(); }, error => {
      if (!live) return; const code = error instanceof ApiRequestError ? error.body?.code : null;
      const message = code === 'RUN_SHARE_EXPIRED' ? '分享已过期' : code === 'RUN_SHARE_REVOKED' ? '分享已撤销' : code === 'RUN_SHARE_NOT_FOUND' ? '分享不存在' : '无法读取分享，请检查网络后重试';
      setState({ kind: 'error', message, retryable: !['RUN_SHARE_EXPIRED', 'RUN_SHARE_REVOKED', 'RUN_SHARE_NOT_FOUND'].includes(code ?? '') });
    });
    document.addEventListener('visibilitychange', visible);
    return () => { live = false; controller.abort(); if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [token, attempt]);
  return <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:py-12"><div className="mx-auto max-w-4xl space-y-6"><header className="border-b pb-4"><p className="text-sm text-muted-foreground">Manao · 运行结果分享</p><h1 className="mt-2 text-2xl font-semibold">运行结果</h1></header>
    {state.kind === 'loading' ? <p role="status">正在加载分享…</p> : state.kind === 'error' ? <section role="alert" className="space-y-4 rounded-xl border p-6"><p>{state.message}</p>{state.retryable && <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>重试</Button>}</section> : <><p className="text-sm text-muted-foreground">分享创建：<time dateTime={state.share.createdAt}>{shareTime(state.share.createdAt)}</time><br />到期时间：<time dateTime={state.share.expiresAt}>{shareTime(state.share.expiresAt)}</time></p><RunShareContent title={state.share.title} description={state.share.description} snapshot={state.share.snapshot} /></>}
  </div></main>;
}
