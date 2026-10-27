import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ConversationSidebar } from './ConversationSidebar';
import './AgentChat.css';
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
export type AgentConversationPanelProps = AgentTaskPanelProps & { historyTarget?: HTMLElement | null;
  onReleasedControlTask?: (task: NonNullable<AgentTaskPanelProps['settledTask']>) => void;
  controlReloadedTaskId?: string | null };
export function AgentConversationPanel(props: AgentConversationPanelProps) {
  return <ConversationPanel key={JSON.stringify([props.userId, props.projectId])} {...props} />;
}
function ConversationPanel(props: AgentConversationPanelProps) {
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
  useEffect(() => {
    if (!props.task?.writesLocked && !detail.isError && !round.isError && selectedSnapshot
      && selectedSnapshot.taskId === selectedTaskId && !selectedSnapshot.writesLocked
      && ['AI_PAUSED_BY_OWNER', 'AI_WORKER_RESTARTED'].includes(selectedSnapshot.closeReasonCode ?? '')) {
      props.onReleasedControlTask?.(selectedSnapshot);
    }
  }, [props.task?.writesLocked, props.onReleasedControlTask, detail.isError, round.isError, selectedSnapshot, selectedTaskId]);
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
  const sendCompact = async (intent: CompactIntent, retry = false) => {
    if (compactSending || storedCompact(compactKey)?.requestId !== intent.requestId) return;
    setCompactSending(true);
    if (scope.selected === intent.conversationId) setError(null);
    try { const view = await compactAgentConversation(projectId, intent.conversationId, intent); if (scope.active) acceptCompact(view, intent); }
    catch (failure) {
      const original = await reconcileCompact(intent);
      // A retry refusal cannot fence an original POST still in flight. A changed head fences its old base.
      if (scope.active && original !== null && original.compactRequestId !== intent.requestId && (!retry || original.headSeq !== intent.expectedHeadSeq) && failure instanceof ApiRequestError && [400, 401, 403, 404, 409, 413, 422].includes(failure.status)) {
        forgetCompact(intent.requestId);
        if (scope.selected === intent.conversationId) setError('压缩请求被拒绝，请稍后重试');
      }
    } finally { if (scope.active) setCompactSending(false); }
  };
  const compact = async () => {
    if (!canCompact || !metadata) return;
    const intent = { conversationId: metadata.conversationId, requestId: generateAgentTaskId(), expectedHeadSeq: metadata.headSeq };
    // Persist the original identity BEFORE POST. Explicit retry reuses it, even after remount/switch.
    sessionStorage.setItem(compactKey, JSON.stringify(intent)); setCompactIntent(intent);
    await sendCompact(intent);
  };
  const onAccepted: AgentTaskPanelProps['onTaskAccepted'] = snapshot => {
    if (!scope.active) return;
    props.onTaskAccepted(snapshot);
    void client.invalidateQueries({ queryKey: conversationKeys.all(userId, projectId) });
  };
  const sidebar = <ConversationSidebar items={conversations} selectedId={selected} creating={creating}
    hasMore={list.hasNextPage} loadingMore={list.isFetching} onSelect={choose}
    onCreate={() => void create()} onLoadMore={() => void list.fetchNextPage()} />;
  const historyNavigation = props.historyTarget === undefined ? sidebar
    : props.historyTarget === null ? null : createPortal(sidebar, props.historyTarget);
  const conversationHeader = metadata ? <div className="manao-ai-conversation-header">
      <h2 className="manao-ai-conversation-title">{metadata.title}</h2>
      <Button size="sm" variant="outline" disabled={!canCompact} onClick={() => void compact()}>压缩上下文</Button>
      {metadata.compactState === 'RUNNING' ? <span>压缩中</span> : null}
      {metadata.compactState === 'COMPLETED' ? <span>压缩完成</span> : null}
      {metadata.compactState === 'FAILED' ? <span>压缩失败</span> : null}
      {compactIntent ? <Button size="sm" variant="outline" disabled={compactSending} onClick={() => void reconcileCompact(compactIntent)}>核对压缩状态</Button> : null}
      {compactIntent ? <Button size="sm" variant="outline" disabled={compactSending} onClick={() => void sendCompact(compactIntent, true)}>重试原压缩请求</Button> : null}
    </div> : null;
  const conversationHistory = selected && metadata ? <ConversationHistory userId={userId} projectId={projectId} conversationId={selected} headSeq={metadata.headSeq} taskId={legacy ? null : selectedSnapshot?.taskId ?? selectedTaskId} terminal={selectedSnapshot != null && !['QUEUED', 'RUNNING'].includes(selectedSnapshot.state)} onViewRun={props.onViewRun} /> : null;
  return <section aria-label="AI 会话" className="manao-ai-conversation">
    {historyNavigation}
    {(error || list.isError || detail.isError) ? <div role="alert" className="p-3">{error ?? '无法加载会话'}</div> : null}
    {props.task?.writesLocked && props.task.conversationId && props.task.conversationId !== selected ? <Button variant="outline" onClick={() => choose(props.task!.conversationId!)}>项目有任务运行中</Button> : null}
    <AgentTaskPanel conversationHeader={conversationHeader} conversationHistory={conversationHistory} key={`${selected ?? 'legacy'}:${metadata ? 'ready' : 'pending'}`} nextReasoningEffort={metadata?.nextReasoningEffort} {...props} contextUsage={detail.isError ? null : metadata?.usage} conversationId={selected ?? undefined} fullHistory={!legacy && selected !== null} displayTask={legacy ? legacyTask : selectedSnapshot} continuationAllowed={!legacy && selectedTaskId !== null && selectedSnapshot?.taskId === selectedTaskId && !round.isError} submissionBlocked={selected === null || !metadata || detail.isError || list.isError || compactBusy || Boolean(props.onReleasedControlTask && selectedSnapshot && !selectedSnapshot.writesLocked && ['AI_PAUSED_BY_OWNER', 'AI_WORKER_RESTARTED'].includes(selectedSnapshot.closeReasonCode ?? '') && props.controlReloadedTaskId !== selectedSnapshot.taskId)} onTaskAccepted={onAccepted} onSubmissionPendingChange={pending => { if (scope.active) { setTaskSubmitting(pending); props.onSubmissionPendingChange?.(pending); } }} />
  </section>;
}
