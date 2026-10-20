import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAgentToolCallResult } from '@/api/agentTaskApi';
import type { HistoryItem, HistoryPage } from '@/contracts/agentConversation';
import { Button } from '@/components/ui/button';
import { ToolResultView } from './AgentTaskPanel';
import { useConversationHistory, useConversationTask } from './agentConversationQueries';
import { AssistantMarkdown } from './AssistantMarkdown';
import { ThinkingBlock } from './ThinkingBlock';
import type { LiveSnapshot } from './agentLiveOutput';
import { useAgentLiveOutput } from './useAgentLiveOutput';

export type ConversationHistoryProps = {
  userId: string; projectId: string; conversationId: string; headSeq: number;
  onViewRun?: (runId: string) => void; taskId?: string | null; terminal?: boolean; liveSnapshot?: LiveSnapshot | null;
};
type Message = HistoryItem & { key: string; partial: boolean };
function messages(pages: HistoryPage[], hasEarlier: boolean): Message[] {
  const groups = new Map<string, HistoryItem[]>();
  for (const page of [...pages].reverse()) for (const item of page.items) {
    const key = JSON.stringify([item.seq, item.contentIndex, item.taskId, item.kind, item.toolCallId]);
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  }
  return [...groups].map(([key, fragments]) => {
    fragments.sort((a, b) => a.textOffset - b.textOffset);
    const first = fragments[0]!; let text = '', end = first.textOffset;
    const seen = new Map<number, string>();
    for (const fragment of fragments) {
      if (seen.has(fragment.textOffset)) {
        if (seen.get(fragment.textOffset) !== fragment.text) throw new Error('Conflicting history fragment');
        continue;
      }
      if (fragment.textOffset !== end) throw new Error('Gapped or overlapping history');
      seen.set(fragment.textOffset, fragment.text); text += fragment.text; end += fragment.text.length;
    }
    if (first.textOffset > 0 && !hasEarlier) throw new Error('Missing history prefix');
    return { ...first, text, key, partial: first.textOffset > 0, modelTruncated: fragments.some(fragment => fragment.modelTruncated) };
  }).sort((a, b) => a.seq - b.seq || a.contentIndex - b.contentIndex);
}
// Match the first native assistant message after the saved cut, never a later similar reply.
function correspondingSequence(snapshot: LiveSnapshot, rows: Message[], acknowledged = false): number | null {
  const current = snapshot.current; if (!current) return null;
  const first = rows.find(row => row.seq > snapshot.durableHeadSeq && row.taskId === snapshot.taskId && ['assistant', 'thinking', 'tool_call'].includes(row.kind));
  if (!first) return null;
  const group = rows.filter(row => row.seq === first.seq && row.taskId === snapshot.taskId);
  if (group.some(row => row.partial)) return null;
  const matches = acknowledged || current.blocks.every(block => {
    const row = group.find(row => row.contentIndex === block.contentIndex && row.kind === (block.kind === 'text' ? 'assistant' : 'thinking'));
    return row !== undefined && (current.displayTruncated ? row.text.startsWith(block.text) : row.text === block.text);
  });
  return matches ? first.seq : null;
}
type Visible = { head: number; snapshot: LiveSnapshot | null; choices: Record<number, boolean>; promoted: { seq: number; choices: Record<number, boolean> } | null; settled: boolean; warning: boolean; reconciledRevision: number };
export function ConversationHistory(props: ConversationHistoryProps) {
  return <HistoryComposition key={JSON.stringify([props.userId, props.projectId, props.conversationId, props.taskId])} {...props} />;
}
function HistoryComposition(props: ConversationHistoryProps) {
  const element = useRef<HTMLElement>(null), scrollContainer = useRef<HTMLElement | null>(null), follow = useRef(true);
  useLayoutEffect(() => {
    let parent = element.current?.parentElement ?? null;
    while (parent && !['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
    scrollContainer.current = parent;
    const track = () => { if (parent) follow.current = parent.scrollHeight - parent.scrollTop - parent.clientHeight < 80; };
    track(); parent?.addEventListener('scroll', track, { passive: true }); return () => parent?.removeEventListener('scroll', track);
  }, []);
  const [visible, setVisible] = useState<Visible>(() => ({ head: props.liveSnapshot?.durableHeadSeq ?? props.headSeq, snapshot: null, choices: {}, promoted: null, settled: false, warning: false, reconciledRevision: -1 }));
  const stream = useAgentLiveOutput({ ...props, taskId: props.taskId ?? null, enabled: !visible.settled && props.liveSnapshot === undefined });
  const latest = props.liveSnapshot === undefined ? stream.latest : props.liveSnapshot;
  useEffect(() => { if (visible.settled && props.headSeq > visible.head) setVisible(old => ({ ...old, settled: false, warning: false })); }, [props.headSeq, visible.head, visible.settled]);
  const desired = latest && latest.revision > visible.reconciledRevision && (visible.reconciledRevision < 0 || latest.durableHeadSeq >= visible.head) ? latest : visible.snapshot;
  const pendingMessage = desired?.current && visible.snapshot?.current && desired.current.messageOrdinal !== visible.snapshot.current.messageOrdinal ? desired : null;
  // An accepted newer cut confirms the old native message even if its last deltas were lost.
  const normalAck = Boolean(desired && visible.snapshot?.current && desired.taskId === visible.snapshot.taskId && desired.revision > visible.snapshot.revision && desired.durableHeadSeq > visible.snapshot.durableHeadSeq && (desired.current === null || desired.current.messageOrdinal > visible.snapshot.current.messageOrdinal));
  const fallback = latest?.unavailable || props.liveSnapshot === undefined && ['history', 'unavailable', 'reconnecting'].includes(stream.connectionState);
  const reconcile = Boolean(!normalAck && (props.terminal || fallback) && visible.snapshot?.current && !visible.settled);
  const targetHead = visible.settled ? visible.head : normalAck ? desired!.durableHeadSeq : pendingMessage ? pendingMessage.durableHeadSeq : fallback || reconcile || props.terminal && !desired?.current ? Math.max(props.headSeq, desired?.durableHeadSeq ?? 0, visible.head) : desired?.durableHeadSeq ?? props.headSeq;
  const history = useConversationHistory({ ...props, headSeq: visible.head });
  const pending = useConversationHistory({ ...props, headSeq: targetHead, enabled: !visible.settled });
  const needsBoundary = Boolean(visible.snapshot?.current && (reconcile || targetHead !== visible.head));
  const tail = pending.data?.pages.at(-1);
  const coversCut = tail !== undefined && (tail.nextBeforeSeq === null || tail.nextBeforeSeq <= (visible.snapshot?.durableHeadSeq ?? 0));
  let pendingRows: Message[] = [], pendingBroken = false;
  try { pendingRows = messages(pending.data?.pages ?? [], pending.hasNextPage); } catch { pendingBroken = true; }
  useEffect(() => {
    if (needsBoundary && !coversCut && pending.hasNextPage && !pending.isFetching && !pending.isError) void pending.fetchNextPage();
  }, [needsBoundary, coversCut, pending.hasNextPage, pending.isFetching, pending.isError, pending.fetchNextPage]);
  useEffect(() => {
    if (visible.settled || !pending.data || pending.isError || pendingBroken || needsBoundary && !coversCut) return;
    if (reconcile) {
      const seq = correspondingSequence(visible.snapshot!, pendingRows);
      if (seq === null) { if (!visible.warning) setVisible(old => ({ ...old, warning: true })); return; }
      setVisible(old => ({ head: targetHead, snapshot: pendingMessage, choices: {}, promoted: { seq, choices: old.choices }, settled: Boolean(props.terminal && pendingMessage === null), warning: false, reconciledRevision: Math.max(old.reconciledRevision, old.snapshot!.revision) })); return;
    }
    if (visible.snapshot === desired && visible.head === targetHead) return;
    if (fallback && !normalAck && !desired?.current) {
      setVisible(old => ({ ...old, head: targetHead, snapshot: null, settled: Boolean(props.terminal), warning: false, reconciledRevision: Math.max(old.reconciledRevision, latest?.revision ?? -1) })); return;
    }
    const sameMessage = desired?.current && visible.snapshot?.current && desired.taskId === visible.snapshot.taskId && desired.current.messageOrdinal === visible.snapshot.current.messageOrdinal;
    const seq = !sameMessage && visible.snapshot?.current ? correspondingSequence(visible.snapshot, pendingRows, normalAck) : null;
    setVisible(old => ({ head: targetHead, snapshot: desired, choices: sameMessage ? old.choices : {}, promoted: seq === null ? old.promoted : { seq, choices: old.choices }, settled: Boolean(props.terminal && desired !== null && desired.current === null), warning: false, reconciledRevision: old.reconciledRevision }));
  }, [desired, latest, pendingMessage, normalAck, fallback, targetHead, pending.data, pending.isError, pendingBroken, needsBoundary, coversCut, reconcile, visible, props.terminal]);
  let rows: Message[] = [], incomplete = false;
  try { rows = messages(history.data?.pages ?? [], history.hasNextPage); } catch { incomplete = true; }
  const draft = visible.snapshot?.current;
  useLayoutEffect(() => { const parent = scrollContainer.current; if (parent && follow.current) parent.scrollTop = parent.scrollHeight; }, [visible.snapshot, history.data]);
  const syncing = !visible.settled && (reconcile || desired !== visible.snapshot || !latest && props.taskId != null || stream.connectionState === 'connecting' || stream.connectionState === 'reconnecting') && (props.taskId != null || latest !== null);
  return <section ref={element} aria-label="会话历史" className="manao-ai-messages">
    {(history.isError || pending.isError) ? <div role="alert">无法加载会话历史</div> : null}
    {(incomplete || pendingBroken) ? <div role="alert">历史片段不完整，请重新加载</div> : null}
    {(history.isError || pending.isError || incomplete || pendingBroken) ? <Button variant="outline" onClick={() => { void history.refetch(); void pending.refetch(); }}>重新加载历史</Button> : null}
    {history.hasNextPage ? <Button variant="outline" disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>加载更早历史</Button> : null}
    {rows.map(row => <article key={row.key} data-task-id={row.taskId ?? undefined} data-message-seq={row.seq} className={`manao-ai-message manao-ai-message-${row.kind}`}>
      {row.kind === 'user' && row.taskId !== null ? <RoundStatus {...props} taskId={row.taskId} /> : null}
      <div className="manao-ai-message-label">{row.kind === 'user' ? '用户' : row.kind === 'assistant' || row.kind === 'thinking' ? 'AI' : row.kind === 'compaction' ? '上下文已压缩' : '工具'}</div>
      {row.partial && row.kind !== 'thinking' ? <div className="manao-ai-message-notice">还有更早内容</div> : null}
      {row.kind === 'assistant' ? <AssistantMarkdown text={row.text} />
        : row.kind === 'thinking' ? <ThinkingBlock text={row.text} active={false} incomplete={row.partial} initialChoice={visible.promoted?.seq === row.seq ? visible.promoted.choices[row.contentIndex] : undefined} />
        : <pre className="manao-ai-message-text">{row.text}</pre>}
      {row.modelTruncated ? <div className="manao-ai-message-warning">模型响应达到输出上限，本条内容可能不完整</div> : null}
      {row.kind === 'tool_result' && row.taskId !== null && row.toolCallId !== null ? <HistoryTool key={JSON.stringify([props.userId, props.projectId, props.conversationId, row.key])} {...props} taskId={row.taskId} toolCallId={row.toolCallId} /> : null}
    </article>)}
    {draft ? <article aria-label="实时预览" data-task-id={visible.snapshot!.taskId} data-message-ordinal={draft.messageOrdinal} className="manao-ai-message manao-ai-message-assistant">
      {[...draft.blocks].sort((a, b) => a.contentIndex - b.contentIndex).map(block => block.kind === 'thinking'
        ? <ThinkingBlock key={JSON.stringify([draft.messageOrdinal, block.contentIndex])} text={block.text} active={draft.phase === 'generating'} choice={visible.choices[block.contentIndex]} onChoice={open => setVisible(old => ({ ...old, choices: { ...old.choices, [block.contentIndex]: open } }))} />
        : <AssistantMarkdown key={JSON.stringify([draft.messageOrdinal, block.contentIndex])} text={block.text} />)}
      {draft.modelTruncated ? <div className="manao-ai-message-warning">模型响应达到输出上限，本条内容可能不完整</div> : null}
      {draft.displayTruncated ? <div className="manao-ai-message-notice">实时预览已裁切，完整内容请在保存后查看历史</div> : null}
    </article> : null}
    {syncing ? <div role="status" className="manao-ai-message-notice">同步中</div> : null}
    {visible.warning ? <div role="alert" className="manao-ai-message-warning">实时预览未确认保存</div> : null}
    {!visible.settled && (stream.connectionState === 'unavailable' || latest?.unavailable) ? <div role="status" className="manao-ai-message-notice">实时展示暂不可用，继续同步历史 <Button size="sm" variant="outline" onClick={stream.retry}>重连实时展示</Button></div> : null}
  </section>;
}
function RoundStatus(props: ConversationHistoryProps & { taskId: string }) {
  const task = useConversationTask(props.userId, props.projectId, props.conversationId, props.taskId);
  return <div className="manao-ai-round-status">本轮状态：{task.data?.state ?? (task.isError ? '暂不可用' : '加载中')}</div>;
}
function HistoryTool(props: ConversationHistoryProps & { taskId: string; toolCallId: string }) {
  const [open, setOpen] = useState(false);
  const result = useQuery({ queryKey: ['conversation-tool-result', props.userId, props.projectId, props.conversationId, props.taskId, props.toolCallId], queryFn: () => getAgentToolCallResult(props.projectId, props.taskId, props.toolCallId), enabled: open, retry: false, refetchOnWindowFocus: false });
  return <div className="manao-ai-tool-result">
    <Button variant="outline" size="sm" disabled={result.isFetching} onClick={() => setOpen(true)}>查看工具结果</Button>
    {open && result.isError ? <div role="alert">无法加载工具结果</div> : null}
    {open && result.data ? <ToolResultView result={result.data} onViewRun={props.onViewRun} /> : null}
  </div>;
}
