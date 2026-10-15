import { CircleAlert, CircleCheck, Clock3, History } from 'lucide-react';
import { Link } from 'react-router';
import { formatLabDate, runStateLabels } from '@/components/ui/labPresentation';
import { flattenRunHistoryPages, useRunHistoryQuery } from '@/features/runs/runQueries';

export function ProjectLatestRun({ projectId }: { projectId: string }) {
  const history = useRunHistoryQuery(projectId);
  const latest = flattenRunHistoryPages(history.data?.pages ?? [])[0];
  if (history.isPending) return <p className="lab-card-run" role="status"><Clock3 aria-hidden="true" />正在读取最近运行</p>;
  if (history.isError && !latest) return <button type="button" className="lab-card-run" onClick={() => void history.refetch()}><CircleAlert aria-hidden="true" />运行记录暂不可用 · 重试</button>;
  const Icon = latest?.state === 'SUCCEEDED' ? CircleCheck : latest?.state === 'FAILED' || latest?.state === 'TIMED_OUT' ? CircleAlert : History;
  return <Link className="lab-card-run" data-state={latest?.state} to={`/projects/${encodeURIComponent(projectId)}?panel=run`}>
    <Icon aria-hidden="true" />
    <span>{latest ? runStateLabels[latest.state] : '尚无运行记录'}{history.isError ? ' · 更新失败' : ''}</span>
    {latest ? <time dateTime={latest.createdAt}>{formatLabDate(latest.createdAt)}</time> : null}
  </Link>;
}
