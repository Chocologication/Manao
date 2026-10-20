import { forwardRef, useMemo } from 'react';
import { CircleCheck, CircleDashed, ExternalLink, FileClock, LayoutDashboard, LockKeyhole, Play, X } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { runStateLabels } from '@/components/ui/labPresentation';
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
  const projectStateLabel = { READY: '环境就绪', CREATING: '正在创建', FAILED: '创建失败', DELETING: '正在删除' }[project.state];

  return (
    <aside ref={ref} className="lab-insights" data-open="true" aria-label="运行洞察" role={compactViewport ? 'dialog' : undefined} aria-modal={compactViewport ? 'true' : undefined} tabIndex={compactViewport ? -1 : undefined}>
      <header className="lab-insights-title">
        <Button type="button" variant="ghost" size="icon" className="lab-mobile-close lab-insights-close" aria-label="关闭项目洞察" onClick={onClose}><X aria-hidden="true" /></Button>
        <p className="lab-eyebrow">RUN INSIGHTS</p>
        <h2>运行洞察</h2>
        <span className="lab-insight-source">基于当前项目与运行记录</span>
        <Button type="button" variant="ghost" size="sm" className="lab-overview-link" render={<Link to={`/projects/${encodeURIComponent(project.id)}/overview`} />}><LayoutDashboard aria-hidden="true" />项目概览</Button>
      </header>
      <section>
        <h3>环境与权限</h3>
        <dl>
          <EvidenceRow label="模板" value={RUNTIME_TEMPLATE_META[templateId].label} />
          <EvidenceRow label="工作区" value={projectStateLabel} />
          <EvidenceRow label="文件权限" value={writesLocked ? '当前操作锁定写入' : '可编辑'} />
          {project.runtime?.mysql ? <EvidenceRow label="MySQL" value={project.dependencies?.mysql ?? '状态未提供'} /> : null}
          {project.runtime?.redis ? <EvidenceRow label="Redis" value={project.dependencies?.redis ?? '状态未提供'} /> : null}
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
              <EvidenceRow label="日志序号" value={run.lastLogSeq === null ? '暂无日志' : `#${run.lastLogSeq}`} />
              <EvidenceRow label="Workspace revision" value={run.requestedWorkspaceRevision} />
            </dl>
            <Button type="button" variant="ghost" size="sm" className="lab-insight-open" onClick={onOpenRuns}>
              <Play aria-hidden="true" />查看运行与日志
            </Button>
          </>
        ) : (
          <div className="lab-insight-empty">
            <FileClock aria-hidden="true" />
            <p>尚无运行记录</p>
            <Button type="button" variant="ghost" size="sm" onClick={onOpenRuns}><Play aria-hidden="true" />启动首次运行</Button>
          </div>
        )}
        {(activeError || history.isError) && run ? <InlineAlert>状态更新失败，显示最近已读取的运行记录</InlineAlert> : null}
      </section>
      <section className="lab-stage-preview" aria-label="运行状态映射预览">
        <div className="lab-insight-section-heading">
          <h3>运行状态轨迹</h3>
          <span>预览</span>
        </div>
        <ol>
          <li data-complete={project.state === 'READY'}><CircleCheck aria-hidden="true" /><span><strong>运行环境</strong><small>项目状态：{projectStateLabel}</small></span></li>
          <li data-complete={run?.finishedAt !== null && run !== null}><CircleDashed aria-hidden="true" /><span><strong>代码执行</strong><small>{run ? runStateLabels[run.state] : '等待首次运行'}</small></span></li>
          <li data-complete={hasEvidence}><CircleDashed aria-hidden="true" /><span><strong>运行证据</strong><small>{hasEvidence ? `已记录至 #${run.lastLogSeq}` : '等待日志记录'}</small></span></li>
        </ol>
        <p>按 Run 状态整理的界面预览，不代表后端实时阶段事件。</p>
      </section>
      {project.endpoints?.length ? (
        <section>
          <h3>服务访问</h3>
          {project.endpoints.map((endpoint) => (
            <div className="lab-endpoint" key={endpoint.name}>
              <span>{endpoint.targetPort} → {endpoint.publicPort}</span>
              {endpoint.url && /^https?:\/\//i.test(endpoint.url)
                ? <a href={endpoint.url} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />打开服务</a>
                : <span>地址待确认</span>}
            </div>
          ))}
        </section>
      ) : null}
      <section className="lab-ai-placeholder" aria-label="AI 诊断预览">
        <div className="lab-insight-section-heading">
          <h3>AI 诊断</h3>
          <span className="lab-planned">预览 · 未接入</span>
        </div>
        <p>当前不会生成 AI 诊断结论；接入真实 AI 服务后再展示分析结果。</p>
        <LockKeyhole aria-hidden="true" />
      </section>
    </aside>
  );
});
