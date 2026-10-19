import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '@/api/ApiRequestError';
import { compactAgentConversation, createAgentConversation, getAgentConversation } from '@/api/agentConversationApi';
import { generateAgentTaskId } from '@/api/agentTaskApi';
import { Button } from '@/components/ui/button';
import type { ConversationView } from '@/contracts/agentConversation';
import { AgentTaskPanel, type AgentTaskPanelProps } from './AgentTaskPanel';
import { ConversationHistory } from './ConversationHistory';
import { conversationKeys, useConversationDetail, useConversationList, useConversationTask } from './agentConversationQueries';

type CompactIntent = { conversationId: string; requestId: string; expectedHeadSeq: number };
function storedCompact(key: string): CompactIntent | null {
  try { const p = JSON.parse(sessionStorage.getItem(key) ?? 'null') as CompactIntent | null; return p && typeof p.conversationId === 'string' && typeof p.requestId === 'string' && Number.isSafeInteger(p.expectedHeadSeq) && p.expectedHeadSeq >= 0 ? p : null; } catch { return null; }
}
// A project switch unmounts all local UI state; query data and pending intents remain owner scoped.
export function AgentConversationPanel(props: AgentTaskPanelProps) {
  return <ConversationPanel key={JSON.stringify([props.userId, props.projectId])} {...props} />;
}
function ConversationPanel(props: AgentTaskPanelProps) {
  const { userId, projectId } = props; const client = useQueryClient();
  const selectedKey = `manao.agent-conversation.${userId}.${projectId}`;
  const compactKey = `manao.agent-compact.${userId}.${projectId}`;
  const [selected, setSelected] = useState<string | null>(() => { try { return sessionStorage.getItem(selectedKey); } catch { return null; } });
  const [creating, setCreating] = useState(false), [error, setError] = useState<string | null>(null);
  const [compactIntent, setCompactIntent] = useState(() => storedCompact(compactKey));
  const [compactSending, setCompactSending] = useState(false);
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const scope = useMemo(() => ({ active: true, selected }), []);
  useEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  useEffect(() => { scope.selected = selected; }, [scope, selected]);
  const list = useConversationList(userId, projectId);
  const detail = useConversationDetail(userId, projectId, selected);
  const pendingDetail = useConversationDetail(userId, projectId, compactIntent?.conversationId ?? null);
  const conversations = useMemo(() => [...new Map((list.data?.pages.flatMap(p => p.items) ?? []).map(c => [c.conversationId, c])).values()], [list.data]);
  const choose = useCallback((id: string) => { setSelected(id); setError(null); try { sessionStorage.setItem(selectedKey, id); } catch { /* Preference storage is optional. */ } }, [selectedKey]);
  useEffect(() => { if (selected === null && conversations[0]) choose(conversations[0].conversationId); }, [selected, conversations, choose]);
  const forgetCompact = useCallback((requestId: string) => {
    if (storedCompact(compactKey)?.requestId === requestId) sessionStorage.removeItem(compactKey);
    setCompactIntent(previous => previous?.requestId === requestId ? null : previous);
  }, [compactKey]);
  const acceptCompact = useCallback((view: ConversationView, intent: CompactIntent) => {
    client.setQueryData(conversationKeys.detail(userId, projectId, intent.conversationId), view);
    if (view.compactRequestId === intent.requestId && (view.compactState === 'COMPLETED' || view.compactState === 'FAILED')) forgetCompact(intent.requestId);
    void client.invalidateQueries({ queryKey: conversationKeys.list(userId, projectId) });
  }, [client, userId, projectId, forgetCompact]);
  useEffect(() => {
    if (compactIntent && pendingDetail.data?.compactRequestId === compactIntent.requestId && pendingDetail.data.compactState !== 'RUNNING') acceptCompact(pendingDetail.data, compactIntent);
  }, [compactIntent, pendingDetail.data, acceptCompact]);
  const metadata = detail.data;
  const round = useConversationTask(userId, projectId, selected, metadata?.activeTaskId ?? metadata?.lastTaskId ?? null);
  const selectedTaskId = metadata?.activeTaskId ?? metadata?.lastTaskId ?? null;
  const selectedSnapshot = props.task?.conversationId === selected ? props.task : props.settledTask?.conversationId === selected && props.settledTask.taskId === selectedTaskId ? props.settledTask : round.data ?? null;
  const legacyTask = props.task?.conversationId == null && props.task !== null ? props.task : selectedSnapshot === null && props.settledTask?.conversationId == null ? props.settledTask : null;
  const legacy = legacyTask !== null;
  const compactBusy = compactIntent !== null || compactSending || taskSubmitting || metadata?.compactState === 'RUNNING' || conversations.some(c => c.compactState === 'RUNNING');
  const canCompact = metadata !== undefined && !detail.isError && !props.task?.writesLocked && !props.pollFailed && !list.isError && !compactBusy && !props.reloading;
  const create = async () => {
    setCreating(true); setError(null); const id = generateAgentTaskId();
    try {
      const view = await createAgentConversation(projectId, id);
      if (!scope.active) return;
      client.setQueryData(conversationKeys.detail(userId, projectId, id), view);
      client.setQueryData(conversationKeys.list(userId, projectId), (old: { pages: { items: ConversationView[]; nextCursor: string | null }[]; pageParams: unknown[] } | undefined) => old ? { ...old, pages: [{ ...old.pages[0]!, items: [view, ...old.pages[0]!.items.filter(c => c.conversationId !== id)] }, ...old.pages.slice(1)] } : { pages: [{ items: [view], nextCursor: null }], pageParams: [null] });
      if (scope.selected === selected) choose(id);
    } catch { if (scope.active && scope.selected === selected) setError('无法新建会话'); } finally { if (scope.active) setCreating(false); }
  };
  const reconcileCompact = async (intent: CompactIntent) => {
    try { const view = await getAgentConversation(projectId, intent.conversationId); if (scope.active) acceptCompact(view, intent); return view; }
    catch { if (scope.active && scope.selected === intent.conversationId) setError('压缩状态暂不可用，请核对原请求'); return null; }
  };
  const compact = async () => {
    if (!canCompact || !metadata) return;
    const intent = { conversationId: metadata.conversationId, requestId: generateAgentTaskId(), expectedHeadSeq: metadata.headSeq };
    // Persist the original identity BEFORE POST. Switching conversations never removes it.
    sessionStorage.setItem(compactKey, JSON.stringify(intent)); setCompactIntent(intent); setCompactSending(true); setError(null);
    try { const view = await compactAgentConversation(projectId, intent.conversationId, intent); if (scope.active) acceptCompact(view, intent); }
    catch (failure) {
      const original = await reconcileCompact(intent);
      if (scope.active && original !== null && original.compactRequestId !== intent.requestId && failure instanceof ApiRequestError && [400, 401, 403, 404, 409, 413, 422].includes(failure.status)) {
        forgetCompact(intent.requestId);
        if (scope.selected === intent.conversationId) setError('压缩请求被拒绝，请稍后重试');
      }
    } finally { if (scope.active) setCompactSending(false); }
  };
  const onAccepted: AgentTaskPanelProps['onTaskAccepted'] = snapshot => {
    if (!scope.active) return;
    props.onTaskAccepted(snapshot);
    void client.invalidateQueries({ queryKey: conversationKeys.all(userId, projectId) });
  };
  return <section aria-label="AI 会话" className="flex h-full min-h-0 flex-col overflow-y-auto">
    <nav aria-label="会话列表" className="flex shrink-0 flex-wrap gap-2 border-b p-3">
      <Button size="sm" disabled={creating} onClick={() => void create()}>新建会话</Button>
      {conversations.map(c => <Button key={c.conversationId} size="sm" variant="outline" aria-pressed={selected === c.conversationId} onClick={() => choose(c.conversationId)}>{c.title}</Button>)}
      {list.hasNextPage ? <Button size="sm" variant="outline" disabled={list.isFetching} onClick={() => void list.fetchNextPage()}>更多会话</Button> : null}
    </nav>
    {(error || list.isError || detail.isError) ? <div role="alert" className="p-3">{error ?? '无法加载会话'}</div> : null}
    {props.task?.writesLocked && props.task.conversationId && props.task.conversationId !== selected ? <Button variant="outline" onClick={() => choose(props.task!.conversationId!)}>项目有任务运行中</Button> : null}
    {metadata ? <div className="flex flex-wrap items-center gap-2 p-3 text-xs">
      <span>{metadata.usage?.tokens != null && metadata.usage.percent != null ? `约 ${metadata.usage.percent.toFixed(1)}%` : '占用暂不可用'}</span>
      <Button size="sm" variant="outline" disabled={!canCompact} onClick={() => void compact()}>压缩上下文</Button>
      {metadata.compactState === 'RUNNING' ? <span>压缩中</span> : null}
      {metadata.compactState === 'COMPLETED' ? <span>压缩完成</span> : null}
      {metadata.compactState === 'FAILED' ? <span>压缩失败</span> : null}
      {compactIntent ? <Button size="sm" variant="outline" disabled={compactSending} onClick={() => void reconcileCompact(compactIntent)}>核对压缩状态</Button> : null}
    </div> : null}
    {selected && metadata ? <ConversationHistory userId={userId} projectId={projectId} conversationId={selected} headSeq={metadata.headSeq} onViewRun={props.onViewRun} /> : null}
    <div className="min-h-64 shrink-0"><AgentTaskPanel key={selected ?? 'legacy'} {...props} conversationId={selected ?? undefined} fullHistory={!legacy && selected !== null} displayTask={legacy ? legacyTask : selectedSnapshot} submissionBlocked={selected === null || !metadata || detail.isError || list.isError || compactBusy} onTaskAccepted={onAccepted} onSubmissionPendingChange={pending => { if (scope.active) { setTaskSubmitting(pending); props.onSubmissionPendingChange?.(pending); } }} /></div>
  </section>;
}
