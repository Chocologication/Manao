import { getHttpClient } from './httpClient';
export function getAgentLiveOutput(projectId: string, taskId: string, signal: AbortSignal) {
  return getHttpClient().requestStream('/api/v1/projects/' + encodeURIComponent(projectId) + '/agent-tasks/' + encodeURIComponent(taskId) + '/live-output', { signal });
}
import { parseConversationPage, parseConversationView, parseHistoryPage, type HistoryCursor } from '@/contracts/agentConversation';
import { parseAgentTaskSnapshot, type SubmitAgentTaskRequest } from '@/contracts/agentTask';
function url(projectId: string, conversationId?: string) { return `/api/v1/projects/${encodeURIComponent(projectId)}/conversations${conversationId === undefined ? '' : `/${encodeURIComponent(conversationId)}`}`; }
export async function listAgentConversations(projectId: string, before: string | null, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '20' }); if (before !== null) query.set('before', before);
  return parseConversationPage(await getHttpClient().request(`${url(projectId)}?${query}`, { signal }));
}
export async function createAgentConversation(projectId: string, conversationId: string) { return parseConversationView(await getHttpClient().request(url(projectId), { method: 'POST', body: { conversationId } })); }
export async function getAgentConversation(projectId: string, conversationId: string, signal?: AbortSignal) { return parseConversationView(await getHttpClient().request(url(projectId, conversationId), { signal })); }
export async function getConversationHistory(projectId: string, conversationId: string, cursor: HistoryCursor | null, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor !== null) { query.set('beforeSeq', String(cursor.beforeSeq)); if (cursor.beforeOffset !== null) query.set('beforeOffset', String(cursor.beforeOffset)); }
  return parseHistoryPage(await getHttpClient().request(`${url(projectId, conversationId)}/entries?${query}`, { signal }));
}
export async function submitConversationTask(projectId: string, conversationId: string, request: SubmitAgentTaskRequest) { return parseAgentTaskSnapshot(await getHttpClient().request(`${url(projectId, conversationId)}/tasks`, { method: 'POST', body: request })); }
export async function compactAgentConversation(projectId: string, conversationId: string, request: { requestId: string; expectedHeadSeq: number }) { return parseConversationView(await getHttpClient().request(`${url(projectId, conversationId)}/compact`, { method: 'POST', body: request })); }
