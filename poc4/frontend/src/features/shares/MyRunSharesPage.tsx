import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { type OwnerShare, shareUrl } from '../../contracts/runShare';
import { useAuth } from '../auth/AuthProvider';
import { ShareLinkPanel } from './ShareLinkPanel';
import { shareTime } from './RunShareContent';
import { shareSessionId, useMyRunShares, useRevokeRunShare } from './runShareQueries';

export function MyRunSharesPage() { const { snapshot } = useAuth(); return snapshot.status === 'authenticated' ? <MySharesSession key={shareSessionId(snapshot)} /> : null; }
function MySharesSession() {
  const list = useMyRunShares(); const revoke = useRevokeRunShare(); const [message, setMessage] = useState('');
  const items = [...new Map(list.data?.pages.flatMap(page => page.items).map(item => [item.id, item])).values()];
  async function revokeShare(share: OwnerShare) { setMessage(''); try { await revoke.mutateAsync(share.id); } catch { setMessage('无法确认撤销结果，请重试撤销或刷新列表'); } }
  return <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:py-12"><div className="mx-auto max-w-3xl space-y-6"><header className="flex flex-wrap items-center justify-between gap-4 border-b pb-4"><h1 className="text-2xl font-semibold">我的分享</h1><Link to="/projects" className="text-sm text-primary underline">返回项目</Link></header>
    {message && <p role="alert">{message}</p>}
    {list.isPending ? <p role="status">正在加载分享…</p> : <>
      {list.isError && <section role="alert"><p>无法读取我的分享</p><Button variant="outline" onClick={() => void list.refetch()}>重试</Button></section>}
      {items.length === 0 && !list.isError && <p>暂无分享</p>}
      <ul className="space-y-4">{items.map(share => <li key={share.id} data-share-id={share.id} className="min-w-0 space-y-3 rounded-xl border p-4 sm:p-6"><h2 className="break-words text-lg font-semibold">{share.title}</h2><p className="break-words text-sm text-muted-foreground">{share.sourceProjectName}</p><p className="text-sm">创建时间：<time dateTime={share.createdAt}>{shareTime(share.createdAt)}</time></p>
        {share.status === 'ACTIVE' && share.sharePath ? <><p className="text-sm">有效</p><ShareLinkPanel url={shareUrl(share.sharePath)} expiresAt={share.expiresAt} /><Button variant="outline" disabled={revoke.isPending} onClick={() => void revokeShare(share)}>撤销分享</Button></> : <><p role="status">{share.status === 'EXPIRED' ? '已过期' : '已撤销'}</p><p className="text-sm text-muted-foreground">到期时间：<time dateTime={share.expiresAt}>{shareTime(share.expiresAt)}</time></p></>}
      </li>)}</ul>
      {list.hasNextPage && <Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? '正在加载…' : '加载更多'}</Button>}
    </>}
  </div></main>;
}
