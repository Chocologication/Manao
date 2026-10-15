import { ArrowLeft, ArrowRight, Code2, Database, FileCode2, History, Play, ExternalLink } from 'lucide-react';
import { Link } from 'react-router';
import type { ProjectSummary } from '@/contracts/project';
import { RUNTIME_TEMPLATE_META } from '@/contracts/project';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { LoadingState } from '@/components/feedback/LoadingState';
import { formatLabDate, runStateLabels } from '@/components/ui/labPresentation';
import { useDirectoryTreeQuery } from '@/features/files/fileQueries';
import { parseProjectDirectoryPath } from '@/features/files/pathPolicy';
import { flattenRunHistoryPages, useRunHistoryQuery } from '@/features/runs/runQueries';
import { templateRunDisplay } from '@/contracts/run';
import { AppChrome } from './ProjectsPage';

export function ProjectOverview({ project }: { project: ProjectSummary }) {
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const tree = useDirectoryTreeQuery(project.id, parseProjectDirectoryPath(''));
  const history = useRunHistoryQuery(project.id);
  const runs = flattenRunHistoryPages(history.data?.pages ?? []);
  const template = project.runtime?.templateId ?? 'java-console';
  const display = templateRunDisplay(template);
  const environmentLabel = {
    READY: '环境就绪',
    CREATING: '正在准备',
    FAILED: '准备失败',
    DELETING: '正在删除',
  }[project.state];
  return <AppChrome title={project.name}>
    <div className="lab-overview-actions"><Button variant="outline" render={<Link to="/projects" />}><ArrowLeft />全部项目</Button><Button render={<Link to={base} />}><Code2 />进入工作台</Button><Button variant="outline" render={<Link to={`${base}?panel=run`} />}><Play />运行与日志</Button></div>
    <div className="lab-overview-summary"><div><span className="lab-eyebrow">RUNTIME</span><strong>{RUNTIME_TEMPLATE_META[template].label}</strong></div><div><span className="lab-eyebrow">WORKSPACE</span><strong className={project.state === 'READY' ? 'lab-success' : project.state === 'FAILED' ? 'lab-warning' : ''}>{environmentLabel}</strong>{project.failureReason ? <small className="lab-overview-failure">{project.failureReason}</small> : null}{project.runtime?.mysql ? <small className="lab-overview-dependency">MySQL · {project.dependencies?.mysql ?? '状态未提供'}</small> : null}{project.runtime?.redis ? <small className="lab-overview-dependency">Redis · {project.dependencies?.redis ?? '状态未提供'}</small> : null}</div><div><span className="lab-eyebrow">CREATED</span><strong>{formatLabDate(project.createdAt)}</strong></div></div>
    <section className="lab-overview-section"><div className="lab-section-heading"><h2>开发与运行闭环</h2><span className="lab-section-meta">WORKSPACE → RUN → EVIDENCE</span></div><div className="lab-workflow">{[['代码工作区', FileCode2], ['项目依赖', Database], ['云端执行', Play], ['运行记录', History]].map(([label, Icon], index) => { const StageIcon = Icon as typeof Code2; return <div key={String(label)}><StageIcon size={22} /><span>{String(label)}</span>{index < 3 && <ArrowRight size={14} />}</div>; })}</div></section>
    <div className="lab-overview-columns">
      <section className="lab-overview-section"><div className="lab-section-heading"><h2>工作区文件</h2><span className="lab-section-meta">ROOT</span></div>{tree.isPending ? <LoadingState label="Loading files" /> : tree.isError ? <><InlineAlert>无法读取文件列表</InlineAlert><Button variant="outline" onClick={() => void tree.refetch()}>重试</Button></> : <><ul className="lab-overview-files">{tree.data?.entries.slice(0, 10).map((entry) => <li key={entry.path}><FileCode2 size={16} /><span title={entry.path}>{entry.name}</span><small>{entry.kind === 'directory' ? '目录' : '文件'}</small></li>)}</ul>{(tree.data?.entries.length ?? 0) > 10 ? <p className="lab-section-meta">另有 {tree.data!.entries.length - 10} 项</p> : null}</>}<dl className="lab-overview-runtime"><dt>执行命令</dt><dd><code>{display.command}</code></dd><dt>运行环境</dt><dd>{display.runtimeLabel}</dd></dl></section>
      <section className="lab-overview-section"><div className="lab-section-heading"><h2>最近运行</h2><Button variant="ghost" size="sm" render={<Link to={`${base}/compare`} />}>运行对比<ArrowRight /></Button></div>{history.isError && runs.length === 0 ? <><InlineAlert>无法读取运行历史</InlineAlert><Button variant="outline" onClick={() => void history.refetch()}>重试</Button></> : history.isPending && runs.length === 0 ? <LoadingState label="Loading history" /> : runs.length === 0 ? <div className="lab-empty"><History size={28} /><p>暂无运行记录</p><Button variant="outline" render={<Link to={`${base}?panel=run`} />}>打开运行面板</Button></div> : <>{history.isError ? <InlineAlert>更新失败，显示已读取的运行记录</InlineAlert> : null}<ul className="lab-overview-runs">{runs.slice(0, 5).map((run) => <li key={run.id}><span data-state={run.state}>{runStateLabels[run.state]}</span><small>{formatLabDate(run.createdAt)}</small><code title={run.id}>{run.id}</code><code>exit {run.exitCode ?? '—'}</code><small className="lab-overview-command" title={run.policy.command}>{run.policy.command}</small></li>)}</ul></>}</section>
    </div>
    {!!project.endpoints?.length && <section className="lab-overview-section"><div className="lab-section-heading"><h2>服务访问</h2></div>{project.endpoints.map((endpoint) => <div className="lab-overview-endpoint" key={endpoint.name}><span>{endpoint.targetPort} → {endpoint.publicPort}</span>{endpoint.url && /^https?:\/\//i.test(endpoint.url) ? <a href={endpoint.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />{endpoint.url}</a> : <span>地址待确认</span>}</div>)}</section>}
  </AppChrome>;
}
