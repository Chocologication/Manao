import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAgentToolCallResult } from '@/api/agentTaskApi';
import type { HistoryItem, HistoryPage } from '@/contracts/agentConversation';
import { Button } from '@/components/ui/button';
import { ToolResultView } from './AgentTaskPanel';
import { useConversationHistory, useConversationTask } from './agentConversationQueries';
import { AssistantMarkdown } from './AssistantMarkdown';
import { ThinkingBlock } from './ThinkingBlock';

export type ConversationHistoryProps = {
  userId: string; projectId: string; conversationId: string; headSeq: number;
  onViewRun?: (runId: string) => void;
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
export function ConversationHistory(props: ConversationHistoryProps) {
  const history = useConversationHistory(props);
  let rows: Message[] = [], incomplete = false;
  try { rows = messages(history.data?.pages ?? [], history.hasNextPage); } catch { incomplete = true; }
  return <section aria-label="会话历史" className="flex flex-col gap-3 p-3 text-sm">
    {history.isError ? <div role="alert">无法加载会话历史</div> : null}
    {incomplete ? <div role="alert">历史片段不完整，请重新加载</div> : null}
    {(history.isError || incomplete) ? <Button variant="outline" onClick={() => void history.refetch()}>重新加载历史</Button> : null}
    {history.hasNextPage ? <Button variant="outline" disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>加载更早历史</Button> : null}
    {rows.map(row => <article key={row.key} className="min-w-0 rounded border p-2">
      {row.kind === 'user' && row.taskId !== null ? <RoundStatus {...props} taskId={row.taskId} /> : null}
      <div className="text-xs text-muted-foreground">{row.kind === 'user' ? '用户' : row.kind === 'assistant' || row.kind === 'thinking' ? 'AI' : row.kind === 'compaction' ? '上下文已压缩' : '工具'}</div>
      {row.partial && row.kind !== 'thinking' ? <div>还有更早内容</div> : null}
      {row.kind === 'assistant' ? <AssistantMarkdown text={row.text} />
        : row.kind === 'thinking' ? <ThinkingBlock text={row.text} active={false} incomplete={row.partial} />
        : <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{row.text}</pre>}
      {row.modelTruncated ? <div className="text-destructive text-xs">模型响应达到输出上限，本条内容可能不完整</div> : null}
      {row.kind === 'tool_result' && row.taskId !== null && row.toolCallId !== null ? <HistoryTool key={JSON.stringify([props.userId, props.projectId, props.conversationId, row.key])} {...props} taskId={row.taskId} toolCallId={row.toolCallId} /> : null}
    </article>)}
  </section>;
}
function RoundStatus(props: ConversationHistoryProps & { taskId: string }) {
  const task = useConversationTask(props.userId, props.projectId, props.conversationId, props.taskId);
  return <div className="text-xs">本轮状态：{task.data?.state ?? (task.isError ? '暂不可用' : '加载中')}</div>;
}
function HistoryTool(props: ConversationHistoryProps & { taskId: string; toolCallId: string }) {
  const [open, setOpen] = useState(false);
  const result = useQuery({ queryKey: ['conversation-tool-result', props.userId, props.projectId, props.conversationId, props.taskId, props.toolCallId], queryFn: () => getAgentToolCallResult(props.projectId, props.taskId, props.toolCallId), enabled: open, retry: false, refetchOnWindowFocus: false });
  return <div>
    <Button variant="outline" size="sm" disabled={result.isFetching} onClick={() => setOpen(true)}>查看工具结果</Button>
    {open && result.isError ? <div role="alert">无法加载工具结果</div> : null}
    {open && result.data ? <ToolResultView result={result.data} onViewRun={props.onViewRun} /> : null}
  </div>;
}
