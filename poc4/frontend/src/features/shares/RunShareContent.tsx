import type { SnapshotContent } from '../../contracts/runShare';

export type RunShareContentProps = { title: string; description: string; snapshot: SnapshotContent };
const states = { SUCCEEDED: '运行成功', FAILED: '运行失败', CANCELLED: '已取消', TIMED_OUT: '已超时' };
export function shareTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
export function RunShareContent({ title, description, snapshot }: RunShareContentProps) {
  const { run, logText } = snapshot;
  const elapsed = run.startedAt && run.finishedAt ? Math.max(0, (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000) : null;
  return <article className="min-w-0 space-y-4">
    <header className="space-y-2"><h2 className="break-words text-xl font-semibold">{title}</h2>{description && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{description}</p>}</header>
    <dl className="grid min-w-0 grid-cols-1 gap-3 rounded-xl border bg-muted/30 p-4 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">运行状态</dt><dd>{states[run.state]}</dd></div>
      <div><dt className="text-muted-foreground">退出码</dt><dd>{run.exitCode === null ? '未产生退出码' : run.exitCode}</dd></div>
      <div><dt className="text-muted-foreground">运行环境</dt><dd className="break-words">{run.runtimeLabel}</dd></div>
      <div><dt className="text-muted-foreground">语言</dt><dd>{run.language}</dd></div>
      <div><dt className="text-muted-foreground">创建时间</dt><dd><time dateTime={run.createdAt}>{shareTime(run.createdAt)}</time></dd></div>
      <div><dt className="text-muted-foreground">开始时间</dt><dd>{run.startedAt ? <time dateTime={run.startedAt}>{shareTime(run.startedAt)}</time> : '未开始'}</dd></div>
      <div><dt className="text-muted-foreground">结束时间</dt><dd>{run.finishedAt ? <time dateTime={run.finishedAt}>{shareTime(run.finishedAt)}</time> : '未记录'}</dd></div>
      {elapsed !== null && <div><dt className="text-muted-foreground">耗时</dt><dd>{elapsed} 秒</dd></div>}
    </dl>
    <section aria-label="日志展示"><h3 className="mb-2 text-sm font-medium">运行日志</h3><pre data-testid="run-share-log" role="region" aria-label="运行日志" tabIndex={0} className="rounded-xl border bg-muted/30 p-4 text-xs leading-relaxed" style={{ height: '20rem', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{logText === '' ? '暂无可分享的日志' : logText}</pre></section>
  </article>;
}
