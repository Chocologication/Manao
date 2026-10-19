import { isReasoningEffort, type ReasoningEffort } from './agentTask';
export type ContextUsage = { tokens: number | null; contextWindow: number; percent: number | null };
export type ConversationView = {
  conversationId: string; title: string; headSeq: number; lastTaskId: string | null;
  activeTaskId: string | null; usage: ContextUsage | null;
  compactRequestId: string | null; compactState: 'RUNNING' | 'COMPLETED' | 'FAILED' | null;
  compactFailureCode: string | null;
  nextReasoningEffort?: ReasoningEffort;
};
export type ConversationPage = { items: ConversationView[]; nextCursor: string | null };
export type HistoryItem = { seq: number; taskId: string | null; kind: 'user' | 'thinking' | 'assistant' | 'tool_call' | 'tool_result' | 'compaction'; text: string; toolCallId: string | null; textOffset: number; contentIndex: number; modelTruncated: boolean };
export type HistoryCursor = { beforeSeq: number; beforeOffset: number | null };
export type HistoryPage = { items: HistoryItem[]; nextBeforeSeq: number | null; nextBeforeOffset: number | null };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed conversation response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('Malformed conversation text'); return value; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Malformed conversation offset'); return value; }
function nullableInteger(value: unknown): number | null { return value === null ? null : integer(value); }
export function parseConversationView(payload: unknown): ConversationView {
  const r = record(payload); let usage: ContextUsage | null = null;
  if (r.nextReasoningEffort !== undefined && !isReasoningEffort(r.nextReasoningEffort)) throw new Error('Malformed reasoning effort');
  const nextReasoningEffort = r.nextReasoningEffort as ReasoningEffort | undefined ?? 'high';
  if (r.usage !== null) {
    const u = record(r.usage); const tokens = nullableInteger(u.tokens), contextWindow = integer(u.contextWindow);
    if (contextWindow === 0 || u.percent !== null && (typeof u.percent !== 'number' || !Number.isFinite(u.percent) || u.percent < 0)) throw new Error('Malformed conversation usage');
    usage = { tokens, contextWindow, percent: tokens === null ? null : u.percent as number | null };
  }
  if (r.compactState !== null && !['RUNNING', 'COMPLETED', 'FAILED'].includes(text(r.compactState))) throw new Error('Malformed compaction state');
  return { nextReasoningEffort, conversationId: text(r.conversationId), title: text(r.title), headSeq: integer(r.headSeq), lastTaskId: nullableText(r.lastTaskId), activeTaskId: nullableText(r.activeTaskId), usage, compactRequestId: nullableText(r.compactRequestId), compactState: r.compactState as ConversationView['compactState'], compactFailureCode: nullableText(r.compactFailureCode) };
}
export function parseConversationPage(payload: unknown): ConversationPage {
  const r = record(payload); if (!Array.isArray(r.items)) throw new Error('Malformed conversation list');
  return { items: r.items.map(parseConversationView), nextCursor: nullableText(r.nextCursor) };
}
export function parseHistoryPage(payload: unknown): HistoryPage {
  const r = record(payload); if (!Array.isArray(r.items)) throw new Error('Malformed history');
  const items = r.items.map(value => {
    const i = record(value); const kind = text(i.kind);
    if (!['user', 'thinking', 'assistant', 'tool_call', 'tool_result', 'compaction'].includes(kind)) throw new Error('Unknown history kind');
    if (i.modelTruncated !== undefined && typeof i.modelTruncated !== 'boolean') throw new Error('Malformed model truncation');
    return { seq: integer(i.seq), taskId: nullableText(i.taskId), kind: kind as HistoryItem['kind'], text: text(i.text), toolCallId: nullableText(i.toolCallId), textOffset: integer(i.textOffset), contentIndex: i.contentIndex === undefined ? 0 : integer(i.contentIndex), modelTruncated: i.modelTruncated === undefined ? false : i.modelTruncated as boolean };
  });
  const nextBeforeSeq = nullableInteger(r.nextBeforeSeq), nextBeforeOffset = nullableInteger(r.nextBeforeOffset);
  if (nextBeforeSeq === null && nextBeforeOffset !== null) throw new Error('Malformed history cursor');
  return { items, nextBeforeSeq, nextBeforeOffset };
}
