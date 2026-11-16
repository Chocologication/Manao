import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { createRunShare } from '../../api/runShareApi';
import { ApiRequestError } from '../../api/ApiRequestError';
import { authSession } from '../../app/appRuntime';
import { Button } from '../../components/ui/button';
import { shareUrl, type OwnerShare, type PublishRequest } from '../../contracts/runShare';
import { useAuth } from '../auth/AuthProvider';
import { RunShareContent } from './RunShareContent';
import { ShareLinkPanel } from './ShareLinkPanel';
import { runShareKeys, shareSessionId, useRevokeRunShare, useRunSharePreview } from './runShareQueries';

export type RunShareDialogProps = { projectId: string; runId: string; onClose: () => void };
export function RunShareDialog(props: RunShareDialogProps) {
  const { snapshot } = useAuth();
  if (snapshot.status !== 'authenticated') return null;
  return <ShareDialogSession key={`${shareSessionId(snapshot)}:${props.projectId}:${props.runId}`} {...props} />;
}
function ShareDialogSession({ projectId, runId, onClose }: RunShareDialogProps) {
  const { snapshot: session } = useAuth();
  const queryClient = useQueryClient();
  const preview = useRunSharePreview(projectId, runId);
  const revoke = useRevokeRunShare();
  const publish = useMutation({ retry: false, mutationFn: (request: PublishRequest) => createRunShare(projectId, runId, request) });
  const [title, setTitle] = useState(''); const [description, setDescription] = useState('');
  const [published, setPublished] = useState<OwnerShare | null>(null);
  const [captured, setCaptured] = useState<PublishRequest | null>(null);
  const [message, setMessage] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null); const mounted = useRef(true); const submitting = useRef(false);
  const needsFreshPreview = useRef(false);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const pending = publish.isPending || refreshing || revoke.isPending;
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const titleId = useId(), descriptionId = useId();
  const current = () => mounted.current && session === authSession.getSnapshot();
  useEffect(() => {
    mounted.current = true; const node = dialog.current; if (!node) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof node.showModal === 'function') node.showModal(); else node.setAttribute('open', '');
    node.querySelector<HTMLButtonElement>('[aria-label="关闭分享弹窗"]')?.focus();
    function keys(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!pendingRef.current) closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const nodes = [...node!.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex="0"]')];
      const first = nodes[0], last = nodes.at(-1); if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    node.addEventListener('keydown', keys);
    return () => { mounted.current = false; node.removeEventListener('keydown', keys); if (typeof node.close === 'function' && node.open) node.close(); else node.removeAttribute('open'); trigger?.focus(); };
  }, []);
  async function refreshPreview() {
    setRefreshing(true);
    const fresh = await preview.refetch();
    if (!current()) return false;
    setRefreshing(false);
    if (fresh.isSuccess && needsFreshPreview.current) { setCaptured(null); needsFreshPreview.current = false; setMessage('预览内容已更新，请再次确认后生成链接'); }
    return fresh.isSuccess;
  }
  async function submit() {
    if (submitting.current || pending || preview.data?.kind !== 'PREVIEW') return;
    const request = captured ?? Object.freeze({ requestId: crypto.randomUUID(), snapshotDigest: preview.data.snapshotDigest, title, description });
    submitting.current = true; setCaptured(request); setMessage('');
    try {
      const result = await publish.mutateAsync(request); if (!current()) return;
      setPublished(result); setCaptured(null);
      if (session.status === 'authenticated') void queryClient.invalidateQueries({ queryKey: runShareKeys.owner(session.user.id) });
    } catch (error) {
      if (!current()) return;
      const code = error instanceof ApiRequestError ? error.body?.code : null;
      if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && (code === 'RUN_SHARE_PREVIEW_CHANGED' || code === 'RUN_SHARE_ALREADY_ACTIVE' || code === 'VALIDATION_ERROR')) {
        needsFreshPreview.current = true;
        const refreshed = await refreshPreview(); if (!current()) return;
        if (refreshed) { setMessage(code === 'RUN_SHARE_PREVIEW_CHANGED' ? '预览内容已更新，请再次确认后生成链接' : code === 'VALIDATION_ERROR' ? '请检查标题与说明后重新确认' : '已有有效分享，请管理现有链接'); }
        else setMessage('无法更新预览，请先重试读取预览');
      } else setMessage('尚未确认生成结果，请使用原请求找回结果');
    } finally { if (current()) setRefreshing(false); submitting.current = false; }
  }
  async function revokeShare(share: OwnerShare) {
    setMessage(''); try { await revoke.mutateAsync(share.id); if (current()) setPublished({ ...share, status: Date.parse(share.expiresAt) <= Date.now() ? 'EXPIRED' : 'REVOKED', sharePath: null }); } catch { if (current()) setMessage('无法确认撤销结果，请重试撤销'); }
  }
  const share = published ?? (preview.data?.kind === 'EXISTING' ? preview.data.share : null);
  return <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId} aria-modal="true" onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }} className="m-auto max-h-[90dvh] overflow-y-auto rounded-2xl border bg-background p-4 text-foreground shadow-xl backdrop:bg-black/40 sm:p-6" style={{ width: 'min(48rem, calc(100vw - 2rem))' }}>
    <header className="mb-4 flex items-center justify-between gap-4"><h1 id={titleId} className="text-lg font-semibold">分享运行结果</h1><Button type="button" variant="ghost" aria-label="关闭分享弹窗" disabled={pending} onClick={onClose}>关闭</Button></header>
    <p id={descriptionId} className="mb-4 text-sm text-muted-foreground">持有链接的人可查看。链接生成后 72 小时到期。</p>
    {message && <p role="alert" className="mb-4 rounded-lg border p-3 text-sm">{message}</p>}
    {share ? <section className="space-y-4"><h2 className="break-words font-semibold">{share.title}</h2>{share.status === 'ACTIVE' && share.sharePath ? <><ShareLinkPanel url={shareUrl(share.sharePath)} expiresAt={share.expiresAt} /><Button variant="outline" disabled={pending} onClick={() => void revokeShare(share)}>撤销分享</Button></> : <p role="status">{share.status === 'EXPIRED' ? '已过期' : '已撤销'}</p>}</section> : preview.isPending ? <p role="status">正在加载预览…</p> : preview.isError ? <section role="alert"><p>无法读取分享预览</p><Button variant="outline" disabled={pending} onClick={() => void refreshPreview()}>重试预览</Button></section> : preview.data?.kind === 'PREVIEW' ? <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="block text-sm">分享标题<input aria-label="分享标题" required maxLength={100} value={title} disabled={pending || captured !== null} onChange={(event) => setTitle(event.currentTarget.value)} className="mt-1 block min-h-11 w-full rounded-lg border bg-background px-3" /></label>
      <label className="block text-sm">分享说明<textarea aria-label="分享说明" maxLength={2000} rows={3} value={description} disabled={pending || captured !== null} onChange={(event) => setDescription(event.currentTarget.value)} className="mt-1 block w-full resize-y rounded-lg border bg-background p-3" /></label>
      <RunShareContent title={title || '运行结果预览'} description={description} snapshot={preview.data.snapshot} />
      <Button type="submit" disabled={pending || title.trim() === ''}>{publish.isPending ? '正在生成…' : captured ? '找回原结果' : '生成分享链接'}</Button>
    </form> : null}
  </dialog>;
}
