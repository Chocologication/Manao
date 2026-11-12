import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { applyTurn, pendingApplications } from './api';
import { errorText } from './types';

/** The original journal remains reachable after refresh even when a lost write marked the project FAILED. */
export function StudioRecovery({ userId, projectId, onRecovered }: { userId: string; projectId: string; onRecovered(): void }) {
  const pending = useQuery({ queryKey: ['studio-pending', userId, projectId], queryFn: () => pendingApplications(projectId), retry: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return pending.data?.length || pending.isError ? <section className="my-4 space-y-3" aria-label="恢复未完成的变更">
    <p>上次变更是否应用成功尚未确认，请检查后继续。</p>
    {pending.data?.map(item => <button className="rounded border px-3 py-2" disabled={busy} key={item.turnId} onClick={async () => {
      if (!item.requestId || !item.hunkIds || item.baseRevision === undefined) return;
      setBusy(true); setError('');
      try { await applyTurn(projectId, item.turnId, { requestId: item.requestId, hunkIds: item.hunkIds, expectedRevision: String(item.baseRevision) }); onRecovered(); }
      catch (failure) { setError(errorText(failure)); }
      finally { setBusy(false); }
    }}>{busy ? '正在检查应用结果…' : '检查并继续应用'}</button>)}
    {pending.isError && <button onClick={() => { void pending.refetch(); }}>重新加载待恢复变更</button>}
    {error && <p role="alert">{error}</p>}
  </section> : null;
}
