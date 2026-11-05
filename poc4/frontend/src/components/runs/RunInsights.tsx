import { forwardRef, useMemo } from 'react';
import { CircleCheck, CircleDashed, ExternalLink, FileClock, LayoutDashboard, Play, X } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { dependencyStateLabels, runStateLabels } from '@/components/ui/labPresentation';
import { RUNTIME_TEMPLATE_META, type ProjectSummary } from '@/contracts/project';
import type { RunSummary } from '@/contracts/run';
import { flattenRunHistoryPages, useRunHistoryQuery } from '@/features/runs/runQueries';

function duration(run: RunSummary): string {
  if (run.startedAt === null) return '尚未开始';
  if (run.finishedAt === null) return '进行中';
  const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return `${seconds} 秒`;
}

function EvidenceRow({ label, value }: { label: string; value: string }) {
  return <div className="lab-insight-evidence-row"><dt>{label}</dt><dd title={value}>{value}</dd></div>;
}

export const RunInsights = forwardRef<HTMLElement, {
  project: ProjectSummary;
  activeRun: RunSummary | null;
  activePending: boolean;
  activeError: boolean;
  writesLocked: boolean;
  onOpenRuns: () => void;
  onClose: () => void;
  compactViewport: boolean;
}>(function RunInsights({
  project,
  activeRun,
  activePending,
  activeError,
  writesLocked,
  onOpenRuns,
  onClose,
  compactViewport,
}, ref) {
  const history = useRunHistoryQuery(project.id);
  const latestHistoryRun = useMemo(
    () => flattenRunHistoryPages(history.data?.pages ?? [])[0] ?? null,
    [history.data],
  );
  const run = activeRun ?? latestHistoryRun;
  const templateId = project.runtime?.templateId ?? 'java-console';
  const hasEvidence = run !== null && run.lastLogSeq !== null;
  const projectStateLabel = { READY: '已就绪', CREATING: '正在创建', FAILED: '项目异常', DELETING: '正在删除' }[project.state];

  return (
    <aside ref={ref} className="lab-insights" data-open="true" aria-label="运行概况" role={compactViewport ? 'dialog' : undefined} aria-modal={compactViewport ? 'true' : undefined} tabIndex={compactViewport ? -1 : undefined}>
      <header className="lab-insights-title">
        <Button type="button" variant="ghost" size="icon" className="lab-mobile-close lab-insights-close" aria-label="关闭运行概况" onClick={onClose}><X aria-hidden="true" /></Button>
        <p className="lab-eyebrow">项目与运行概况</p>
        <h2>运行概况</h2>
        <span className="lab-insight-source">基于当前项目与运行记录</span>
        <Button type="button" variant="ghost" size="sm" className="lab-overview-link" render={<Link to={`/projects/${encodeURIComponent(project.id)}/overview`} />}><LayoutDashboard aria-hidden="true" />项目概览</Button>
      </header>
      <section>
        <h3>运行环境与权限</h3>
        <dl>
          <EvidenceRow label="模板" value={RUNTIME_TEMPLATE_META[templateId].label} />
          <EvidenceRow label="项目状态" value={projectStateLabel} />
          <EvidenceRow label="编辑权限" value={writesLocked ? '只读（项目处理中）' : '可编辑'} />
          {project.runtime?.mysql ? <EvidenceRow label="MySQL" value={project.dependencies ? dependencyStateLabels[project.dependencies.mysql] : '状态未提供'} /> : null}
          {project.runtime?.redis ? <EvidenceRow label="Redis" value={project.dependencies ? dependencyStateLabels[project.dependencies.redis] : '状态未提供'} /> : null}
        </dl>
      </section>
      <section>
        <div className="lab-insight-section-heading">
          <h3>最近运行</h3>
          {run ? <span data-state={run.state} className="lab-insight-state">{runStateLabels[run.state]}</span> : null}
        </div>
        {activeError && activeRun === null && latestHistoryRun === null ? (
          <InlineAlert>运行状态暂不可用</InlineAlert>
        ) : (activePending || history.isPending) && run === null ? (
          <p role="status">正在读取运行状态…</p>
        ) : history.isError && run === null ? (
          <InlineAlert>无法读取运行历史</InlineAlert>
        ) : run ? (
          <>
            <dl className="lab-insight-evidence">
              <EvidenceRow label="命令" value={run.policy.command} />
              <EvidenceRow label="运行编号" value={run.id} />
              <EvidenceRow label="耗时" value={duration(run)} />
              <EvidenceRow label="退出码" value={run.exitCode === null ? (run.finishedAt ? '未提供' : '尚未结束') : String(run.exitCode)} />
              <EvidenceRow label="最新日志序号" value={run.lastLogSeq === null ? '暂无日志' : `#${run.lastLogSeq}`} />
              <EvidenceRow label="运行文件版本" value={run.requestedWorkspaceRevision} />
            </dl>
            <Button type="button" variant="ghost" size="sm" className="lab-insight-open" onClick={onOpenRuns}>
              <Play aria-hidden="true" />查看运行记录和日志
            </Button>
          </>
        ) : (
          <div className="lab-insight-empty">
            <FileClock aria-hidden="true" />
            <p>尚无运行记录</p>
            <Button type="button" variant="ghost" size="sm" onClick={onOpenRuns}><Play aria-hidden="true" />打开运行面板</Button>
          </div>
        )}
        {(activeError || history.isError) && run ? <InlineAlert>状态更新失败，显示最近已读取的运行记录</InlineAlert> : null}
      </section>
      <section className="lab-stage-preview" aria-label="项目与运行状态">
        <div className="lab-insight-section-heading">
          <h3>项目与运行状态</h3>
          <span>状态摘要</span>
        </div>
        <ol>
          <li data-complete={project.state === 'READY'}><CircleCheck aria-hidden="true" /><span><strong>运行环境</strong><small>项目状态：{projectStateLabel}</small></span></li>
          <li data-complete={run?.finishedAt !== null && run !== null}><CircleDashed aria-hidden="true" /><span><strong>代码执行</strong><small>{run ? runStateLabels[run.state] : '等待首次运行'}</small></span></li>
          <li data-complete={hasEvidence}><CircleDashed aria-hidden="true" /><span><strong>运行日志</strong><small>{hasEvidence ? `已记录至 #${run.lastLogSeq}` : '等待日志记录'}</small></span></li>
        </ol>
        <p>以下是项目和最近一次运行的状态摘要。</p>
      </section>
      {project.endpoints?.length ? (
        <section>
          <h3>应用访问地址</h3>
          {project.endpoints.map((endpoint) => (
            <div className="lab-endpoint" key={endpoint.name}>
              <span>{endpoint.targetPort} → {endpoint.publicPort}</span>
              {endpoint.url && /^https?:\/\//i.test(endpoint.url)
                ? <a href={endpoint.url} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />打开服务</a>
                : <span>访问地址尚未确认</span>}
            </div>
          ))}
        </section>
      ) : null}
    </aside>
  );
});
