import { useMemo, useState } from 'react';
import { ArrowLeft, History, FileDiff } from 'lucide-react';
import { Link } from 'react-router';
import type { ProjectSummary } from '@/contracts/project';
import { useRunHistoryQuery, flattenRunHistoryPages } from '@/features/runs/runQueries';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { LoadingState } from '@/components/feedback/LoadingState';
import { runStateLabels, formatLabDate } from '@/components/ui/labPresentation';
import { AppChrome } from './ProjectsPage';
import { useRunLogEvidence } from '@/features/logs/useRunLogEvidence';
import { compareLogWindows, errorSummaryFromLog } from './runComparison';

export function RunCompare({ project }: { project: ProjectSummary }) {
  const history = useRunHistoryQuery(project.id);
  const runs = flattenRunHistoryPages(history.data?.pages ?? []);
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const left = runs.find((run) => run.id === leftId) ?? runs[1] ?? runs[0];
  const right = runs.find((run) => run.id === rightId) ?? runs[0];
  const leftLogs = useRunLogEvidence(project.id, runs.length >= 2 ? left?.id ?? null : null);
  const rightLogs = useRunLogEvidence(project.id, runs.length >= 2 ? right?.id ?? null : null);
  const logSummary = (snapshot: typeof leftLogs, run: typeof left) => {
    if (!run) return '—';
    const text = snapshot.runId === run.id ? snapshot.chunks.map((chunk) => chunk.text).join('') : '';
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (snapshot.connection === 'failed') return `读取失败：${snapshot.error ?? '请重新选择运行以重试'}`;
    return lines.length ? `${lines.length} 行 · ${lines.slice(-2).join(' ').slice(0, 180)}` : snapshot.connection === 'complete' ? '已读取，暂无日志输出' : '等待读取日志';
  };
  const logDiff = useMemo(() => {
    if (!left || !right) return null;
    const leftText = leftLogs.chunks.map((chunk) => chunk.text).join('');
    const rightText = rightLogs.chunks.map((chunk) => chunk.text).join('');
    if (!leftText && !rightText) return null;
    return compareLogWindows(leftText, rightText);
  }, [left, leftLogs.chunks, right, rightLogs.chunks]);
  const duration = (run: typeof left) => {
    if (!run?.startedAt || !run.finishedAt) return '—';
    const milliseconds = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    return Number.isFinite(milliseconds) ? `${Math.max(0, Math.round(milliseconds / 1000))} 秒` : '—';
  };
  const rows = left && right ? [
    ['运行编号', left.id, right.id],
    ['运行状态', runStateLabels[left.state], runStateLabels[right.state]],
    ['退出码', String(left.exitCode ?? '—'), String(right.exitCode ?? '—')],
    ['运行耗时', duration(left), duration(right)],
    ['Workspace revision', left.requestedWorkspaceRevision, right.requestedWorkspaceRevision],
    ['开始时间', left.startedAt ? formatLabDate(left.startedAt) : '—', right.startedAt ? formatLabDate(right.startedAt) : '—'],
    ['结束时间', left.finishedAt ? formatLabDate(left.finishedAt) : '—', right.finishedAt ? formatLabDate(right.finishedAt) : '—'],
    ['终止原因', left.terminationReason ?? '—', right.terminationReason ?? '—'],
    ['执行命令', left.policy.command, right.policy.command],
    ['最后日志序号', left.lastLogSeq === null ? '—' : `#${left.lastLogSeq}`, right.lastLogSeq === null ? '—' : `#${right.lastLogSeq}`],
    ['日志截断', left.logTruncated ? '是' : '否', right.logTruncated ? '是' : '否'],
    ['日志读取', logSummary(leftLogs, left), logSummary(rightLogs, right)],
    ['错误摘要（日志规则匹配）', errorSummaryFromLog(leftLogs.chunks.map((chunk) => chunk.text).join('')) || '当前窗口未匹配到错误', errorSummaryFromLog(rightLogs.chunks.map((chunk) => chunk.text).join('')) || '当前窗口未匹配到错误'],
  ] : [];
  const loadMore = history.hasNextPage ? <Button variant="outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? '正在加载…' : '加载更多历史'}</Button> : null;
  return <AppChrome title="运行对比">
    <div className="lab-overview-actions"><Button variant="outline" render={<Link to={`/projects/${encodeURIComponent(project.id)}/overview`} />}><ArrowLeft />项目概览</Button><span className="lab-section-meta">{project.name}</span></div>
    {history.isPending && runs.length === 0 ? <LoadingState label="Loading runs" /> : history.isError && runs.length === 0 ? <><InlineAlert>无法读取运行历史</InlineAlert><Button onClick={() => void history.refetch()}>重试</Button></> : runs.length < 2 ? <><div className="lab-empty"><History size={36} /><h2>{runs.length === 0 ? '暂无运行记录' : '需要至少两次运行记录'}</h2>{runs[0] && <p title={runs[0].id}>最近运行：{runStateLabels[runs[0].state]} · {formatLabDate(runs[0].createdAt)}</p>}<Button render={<Link to={`/projects/${encodeURIComponent(project.id)}?panel=run`} />}>进入运行面板</Button>{loadMore}</div>{history.isError ? <InlineAlert>更新失败，显示已读取记录；可以重试加载历史</InlineAlert> : null}</> : <>
      <div className="lab-compare-pickers"><label>基准运行<select value={left?.id} onChange={(event) => setLeftId(event.target.value)}>{runs.map((run) => <option key={run.id} value={run.id}>{formatLabDate(run.createdAt)} · {runStateLabels[run.state]}</option>)}</select></label><label>对比运行<select value={right?.id} onChange={(event) => setRightId(event.target.value)}>{runs.map((run) => <option key={run.id} value={run.id}>{formatLabDate(run.createdAt)} · {runStateLabels[run.state]}</option>)}</select></label></div>
      {left?.id === right?.id && <p className="lab-warning" role="status">已选择同一次运行，请选择另一条记录进行比较。</p>}
      {(leftLogs.connection === 'failed' || rightLogs.connection === 'failed') && <InlineAlert>部分日志读取失败。请重新选择对应运行重试；当前比较仅使用已读取内容。</InlineAlert>}
      {(leftLogs.window.truncated || rightLogs.window.truncated || left?.logTruncated || right?.logTruncated) && <p className="lab-warning" role="status">日志存在截断，比较结果不代表完整运行输出。</p>}
      <div className="lab-compare-table-wrap" role="region" aria-label="运行对比表格" tabIndex={0}><table className="lab-compare-table"><thead><tr><th>字段</th><th>基准运行</th><th>对比运行</th></tr></thead><tbody>{rows.map(([label, a, b]) => <tr key={label} data-changed={a !== b}><th>{label}</th><td title={a}>{a}</td><td title={b}>{b}</td></tr>)}</tbody></table></div>
      <section className="lab-compare-diff"><div className="lab-section-heading"><h2><FileDiff size={17} />独有日志行</h2><span className="lab-section-meta">{leftLogs.connection} / {rightLogs.connection}</span></div><p className="lab-compare-scope">仅比较已读取窗口中的独有文本行，不比较出现顺序或重复次数；每侧最多显示 8 行。</p>{logDiff ? <div className="grid gap-3 md:grid-cols-2"><div><h3>对比运行独有 · {logDiff.addedCount} 行</h3><pre className="lab-compare-log">{logDiff.added.length ? logDiff.added.join('\n') : '当前窗口没有独有行'}</pre></div><div><h3>基准运行独有 · {logDiff.removedCount} 行</h3><pre className="lab-compare-log">{logDiff.removed.length ? logDiff.removed.join('\n') : '当前窗口没有独有行'}</pre></div></div> : <p className="text-sm text-muted-foreground">日志尚未读取或两次运行均没有日志。</p>}</section>
      {history.isError ? <InlineAlert>无法加载更早的运行记录</InlineAlert> : null}
      {loadMore}
    </>}
  </AppChrome>;
}
