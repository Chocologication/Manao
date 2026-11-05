import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronRight, FileCode2, X, GitCompareArrows, LoaderCircle } from 'lucide-react';
import { applyTurn, getTurn } from './api';
import { errorText, type ApplyInput, type FileChange, type Turn } from './types';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { useQueryClient } from '@tanstack/react-query';
import { projectKeys } from '@/features/projects/projectQueries';
import { ValidationResult } from './ToolProgress';

function ReviewFile({ file, decisions, review, finalized, editable, onChoose }: {
  file: FileChange; decisions: Record<string, boolean>; review: boolean; finalized: boolean; editable: boolean;
  onChoose(hunkIds: string[], accepted: boolean): void;
}) {
  const diffId = useId();
  const [expanded, setExpanded] = useState(false);
  const [selectHunks, setSelectHunks] = useState(false);
  const accepted = file.hunks.filter(hunk => decisions[hunk.id] === true).length;
  const reviewed = file.hunks.filter(hunk => typeof decisions[hunk.id] === 'boolean').length;
  const fullyAccepted = file.hunks.length > 0 && accepted === file.hunks.length;
  const fullyRejected = file.hunks.length > 0 && reviewed === file.hunks.length && accepted === 0;
  const additions = file.hunks.reduce((count, hunk) => count + hunk.after.length, 0);
  const removals = file.hunks.reduce((count, hunk) => count + hunk.before.length, 0);
  const status = fullyAccepted ? '已接受' : fullyRejected ? '已拒绝' : accepted ? '部分接受' : '待审阅';

  return <div className="studio-file-change">
    <div className="studio-file-row">
      <button className="studio-file-toggle" aria-label={`查看 ${file.path} 的修改`} aria-expanded={expanded} aria-controls={diffId} onClick={() => setExpanded(value => !value)}>
        <ChevronRight size={14} className="studio-file-chevron" /><FileCode2 size={15} />
        <span className="studio-file-name"><code title={file.path}>{file.path}</code>{review && <small>{status}</small>}</span>
        <span className="studio-file-stats" aria-label={`新增 ${additions} 行，删除 ${removals} 行`}><span>+{additions}</span><span>−{removals}</span></span>
      </button>
      {review && !finalized && <div className="studio-file-actions">
        <button disabled={!editable} aria-label={`接受文件 ${file.path}`} aria-pressed={fullyAccepted} onClick={() => onChoose(file.hunks.map(hunk => hunk.id), true)}><Check size={13} />接受</button>
        <button disabled={!editable} aria-label={`拒绝文件 ${file.path}`} aria-pressed={fullyRejected} onClick={() => onChoose(file.hunks.map(hunk => hunk.id), false)}><X size={13} />拒绝</button>
      </div>}
    </div>
    <div id={diffId} hidden={!expanded}>
      <div className="studio-file-detail-toolbar"><span>{file.hunks.length} 处修改</span>{review && !finalized && <button aria-pressed={selectHunks} onClick={() => setSelectHunks(value => !value)}>{selectHunks ? '收起代码块审阅' : '按代码块审阅'}</button>}</div>
      {file.hunks.map((hunk, index) => <div className="studio-hunk" key={hunk.id} data-decision={decisions[hunk.id] === true ? 'accepted' : decisions[hunk.id] === false ? 'rejected' : 'pending'}>
        <div className="studio-hunk-head"><code>第 {hunk.start + 1} 行</code>{review && !finalized && selectHunks && <div>
          <button disabled={!editable} aria-label={`接受代码块 ${index + 1}`} aria-pressed={decisions[hunk.id] === true} onClick={() => onChoose([hunk.id], true)}><Check size={13} />接受</button>
          <button disabled={!editable} aria-label={`拒绝代码块 ${index + 1}`} aria-pressed={decisions[hunk.id] === false} onClick={() => onChoose([hunk.id], false)}><X size={13} />拒绝</button>
        </div>}</div>
        <pre aria-label={`代码块 ${index + 1} diff`}>{hunk.before.map((line, i) => <span className="studio-diff-remove" key={`b${i}`}>− {line || ' '}<br /></span>)}{hunk.after.map((line, i) => <span className="studio-diff-add" key={`a${i}`}>+ {line || ' '}<br /></span>)}</pre>
      </div>)}
    </div>
  </div>;
}

export function ReviewChanges({ userId, projectId, turn, blocked, onUpdate, onBusy }: { userId: string; projectId: string; turn: Turn; blocked: boolean; onUpdate(turn: Turn): void; onBusy(pending: boolean, confirmed?: boolean): void }) {
  const key = `manao.studio.review.${userId}.${projectId}.${turn.id}`;
  const client = useQueryClient();
  const [decisions, setDecisions] = useState<Record<string, boolean>>(() => { try { const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, choice]) => typeof choice === 'boolean')) : {}; } catch { return {}; } });
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const hunks = turn.files.flatMap(file => file.hunks); const selected = hunks.filter(h => decisions[h.id] === true);
  const reviewed = hunks.filter(h => typeof decisions[h.id] === 'boolean').length;
  const reviewedFiles = turn.files.filter(file => file.hunks.every(hunk => typeof decisions[hunk.id] === 'boolean')).length;
  const review = turn.applyPolicy === 'REVIEW'; const application = turn.application;
  const finalized = ['COMPLETED', 'VALIDATION_FAILED', 'REJECTED'].includes(application?.state ?? '');
  const editable = review && !finalized && !turn.task?.writesLocked && !pending && !application?.requestId;
  const choose = (next: Record<string, boolean>) => { setDecisions(next); try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* Optional review preference. */ } };
  // File-level choices use the same hunk IDs, preserving partial review and application recovery.
  const chooseHunks = (hunkIds: string[], accepted: boolean) => choose({ ...decisions, ...Object.fromEntries(hunkIds.map(id => [id, accepted])) });
  const apply = async () => {
    if (pending || blocked || useWorkspaceSession.getState().dirtyPaths.size) { setError('请先保存或放弃编辑器中未保存的修改。'); return; }
    const intentKey = `${key}.apply`;
    let input: ApplyInput;
    try { input = JSON.parse(sessionStorage.getItem(intentKey) ?? 'null') as ApplyInput; } catch { input = null as unknown as ApplyInput; }
    input ??= { requestId: application?.requestId ?? crypto.randomUUID(), hunkIds: application?.hunkIds ?? selected.map(h => h.id), expectedRevision: String(application?.baseRevision ?? turn.expectedRevision) };
    try { sessionStorage.setItem(intentKey, JSON.stringify(input)); } catch { setError('浏览器无法记录本次修改操作，请允许使用会话存储后重试。'); return; }
    setPending(true); setError(''); onBusy(true);
    let confirmed = false;
    try {
      const result = await applyTurn(projectId, turn.id, input);
      confirmed = ['COMPLETED', 'VALIDATION_FAILED'].includes(result.state ?? '');
      if (alive.current) onUpdate({ ...turn, application: result });
    } catch (failure) { if (alive.current) setError(errorText(failure)); }
    finally {
      try { const latest = await getTurn(projectId, turn.id); confirmed ||= ['COMPLETED', 'VALIDATION_FAILED'].includes(latest.application?.state ?? ''); if (alive.current) onUpdate(latest); } catch { /* Keep the durable application intent for explicit reconciliation. */ }
      if (alive.current) setPending(false); onBusy(false, confirmed);
      if (!confirmed) void client.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    }
  };
  return <section className="studio-changes" aria-label={review ? '代码审阅' : '代码变更'}>
    <header><GitCompareArrows size={16} /><strong>{review ? '代码审阅' : '代码变更'}</strong><span>{turn.files.length} 个文件</span></header>
    {review && !finalized && <div className="studio-review-toolbar"><span>已审阅 {reviewedFiles}/{turn.files.length} 个文件</span><button disabled={!editable} onClick={() => chooseHunks(hunks.map(hunk => hunk.id), true)}>全部接受</button><button disabled={!editable} onClick={() => chooseHunks(hunks.map(hunk => hunk.id), false)}>全部拒绝</button></div>}
    {turn.files.map(file => <ReviewFile key={file.path} file={file} decisions={decisions} review={review} finalized={finalized} editable={editable} onChoose={chooseHunks} />)}
    {review && !finalized && <div className="studio-apply"><p>{application?.requestId ? '上次应用结果尚未确认，请检查后继续。' : '审阅并选择代码变更，应用后自动执行验证。'}</p><button className="studio-primary" disabled={pending || blocked || !!turn.task?.writesLocked || !application?.requestId && reviewed < hunks.length} onClick={() => { void apply(); }}>{pending ? <LoaderCircle size={14} className="studio-spin" /> : <Check size={14} />}{pending ? '正在应用并验证…' : application?.requestId ? '检查并继续应用' : selected.length || reviewed < hunks.length ? '应用所选变更' : '确认全部拒绝'}</button></div>}
    {error && <p className="studio-error" role="alert">{error}</p>}
    {application?.state === 'REJECTED' && <p className="studio-muted">已拒绝全部修改，项目文件未改动。</p>}
    {application?.validation && <ValidationResult title="应用后验证" data={application.validation} />}
    {application?.state === 'COMPLETED' && <p className="studio-success"><Check size={14} />变更已应用 · 验证通过</p>}
  </section>;
}
