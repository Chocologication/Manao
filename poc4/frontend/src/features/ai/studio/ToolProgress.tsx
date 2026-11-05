import { useState } from 'react';
import { CheckCircle2, ChevronRight, LoaderCircle, Terminal, AlertCircle } from 'lucide-react';
import { getAgentToolCallResult } from '@/api/agentTaskApi';
import { type Turn, type Validation, isActive } from './types';
const names: Record<string, string> = { read_file: '读取文件', list_files: '查看目录', write_file: '生成代码', build: '构建与测试', application: '管理应用', app_http_get: '检查应用', read_logs: '读取日志' };
const goals: Record<string, string> = { test: '运行测试', compile: '编译项目', package: '打包项目', build: '构建项目', verify: '验证项目' };
export function ValidationResult({ title, data }: { title: string; data: Validation }) {
  const pass = data.exitCode === 0 && data.cleanupConfirmed === true && !data.error;
  return <details className={`studio-validation ${pass ? 'is-pass' : 'is-fail'}`}><summary>{pass ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}<strong>{title}</strong><span>{pass ? '通过' : data.exitCode === undefined || data.exitCode === null ? '未确认' : `未通过 · 退出码 ${data.exitCode}`}</span><ChevronRight size={13} /></summary><div><p>{goals[data.goal ?? 'test'] ?? data.goal} · {data.cleanupConfirmed ? '临时执行资源已清理' : '临时执行资源是否清理尚未确认'}</p>{data.testReports?.map(report => <p key={report.testClass}>{report.testClass}：{report.tests} 项，失败 {report.failures + report.errors}，跳过 {report.skipped}</p>)}{!!data.error && <p>工具返回错误，请查看执行详情。</p>}<pre>{data.output || '没有输出记录。'}</pre></div></details>;
}
function TaskTool({ projectId, taskId, name, id, completed, proposal }: { projectId: string; taskId: string; name: string; id: string; completed: boolean; proposal: boolean }) {
  const [data, setData] = useState<Validation | null>(null), [error, setError] = useState(false), [pending, setPending] = useState(false);
  return <details className="studio-tool" onToggle={event => { if (event.currentTarget.open && completed && !data && !pending) { setPending(true); void getAgentToolCallResult(projectId, taskId, id).then(result => { setData(result.data as Validation); setError(false); }).catch(() => setError(true)).finally(() => setPending(false)); } }}><summary>{completed ? <CheckCircle2 size={13} /> : <LoaderCircle size={13} className="studio-spin" />}<span>{names[name] ?? name}</span><small>{completed ? '已完成' : '进行中'}</small></summary><div>{pending ? '读取结果…' : error ? <button onClick={() => { setError(false); setPending(true); void getAgentToolCallResult(projectId, taskId, id).then(result => setData(result.data as Validation)).catch(() => setError(true)).finally(() => setPending(false)); }}>结果暂不可用，重试</button> : data ? name === 'build' ? <ValidationResult title={proposal ? '应用前验证' : '任务结果验证'} data={data} /> : <pre>{JSON.stringify(data, null, 2)}</pre> : '结果将在执行完成后提供。'}</div></details>;
}
export function ToolProgress({ projectId, turn }: { projectId: string; turn: Turn }) {
  const starts = turn.task?.progress.filter(p => p.kind === 'tool_start') ?? [];
  const tools = turn.mode === 'TASK' ? starts.map(p => { const [name = '', id = ''] = p.text.split(' '); return { name, id, completed: turn.task!.progress.some(end => end.kind === 'tool_end' && end.text.split(' ')[1] === id) }; }) : turn.tools.map(t => ({ name: t.name, id: t.id, completed: t.state === 'COMPLETED' }));
  if (!tools.length) return null;
  const active = isActive(turn); const done = tools.filter(t => t.completed).length;
  return <details className="studio-progress"><summary>{active ? <LoaderCircle size={14} className="studio-spin" /> : <Terminal size={14} />}<span>{active ? `${names[tools.at(-1)!.name] ?? '正在处理'}…` : '执行过程'}</span><small>{done}/{tools.length} 步</small><ChevronRight size={14} /></summary><div>{tools.map(tool => turn.mode === 'TASK' ? <TaskTool key={tool.id} projectId={projectId} taskId={turn.id} {...tool} proposal={turn.applyPolicy === 'REVIEW'} /> : <details className="studio-tool" key={tool.id}><summary><CheckCircle2 size={13} />{names[tool.name] ?? tool.name}<small>{tool.completed ? '已完成' : '进行中'}</small></summary><pre>{turn.tools.find(t => t.id === tool.id)?.result ?? '读取中…'}</pre></details>)}</div></details>;
}
