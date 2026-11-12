import { getHttpClient } from '@/api/httpClient';
import { parseTurn, type Attachment, type Conversation, type StudioModel, type ModelInput, type TurnInput, type ApplyInput, type Application } from './types';
const root = (project: string) => `/api/v1/projects/${encodeURIComponent(project)}/assistant`;
export const studioKeys = {
  models: (user: string) => ['studio-models', user] as const,
  conversations: (user: string, project: string) => ['studio-conversations', user, project] as const,
  turns: (user: string, project: string, conversation: string | null) => ['studio-turns', user, project, conversation] as const,
};
export const listModels = () => getHttpClient().request<StudioModel[]>('/api/v1/assistant/models');
export const saveModel = ({ id, label, baseUrl, model, apiKey, vision, tools }: ModelInput) =>
  getHttpClient().request<StudioModel>('/api/v1/assistant/models', {
    method: 'POST', body: { id, label, baseUrl, model, apiKey, vision, tools },
  });
export const deleteModel = (id: string) => getHttpClient().request(`/api/v1/assistant/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const listConversations = (p: string) => getHttpClient().request<Conversation[]>(`${root(p)}/conversations`);
export const createConversation = (p: string, id: string) => getHttpClient().request<Conversation>(`${root(p)}/conversations/${encodeURIComponent(id)}`, { method: 'POST' });
export async function listTurns(p: string, c: string, signal?: AbortSignal) {
  const rows = await getHttpClient().request<unknown[]>(`${root(p)}/conversations/${encodeURIComponent(c)}/turns`, { signal });
  if (!Array.isArray(rows)) throw new Error('Invalid conversation');
  return rows.map(parseTurn);
}
export async function sendTurn(p: string, c: string, body: TurnInput) { return parseTurn(await getHttpClient().request(`${root(p)}/conversations/${encodeURIComponent(c)}/turns`, { method: 'POST', body })); }
export async function getTurn(p: string, id: string) { return parseTurn(await getHttpClient().request(`${root(p)}/turns/${encodeURIComponent(id)}`)); }
export async function stopTurn(p: string, id: string) { return parseTurn(await getHttpClient().request(`${root(p)}/turns/${encodeURIComponent(id)}/stop`, { method: 'POST' })); }
export const applyTurn = (p: string, id: string, body: ApplyInput) => getHttpClient().request<Application>(`${root(p)}/turns/${encodeURIComponent(id)}/apply`, { method: 'POST', body });
export const pendingApplications = (p: string) => getHttpClient().request<(Application & { turnId: string })[]>(`${root(p)}/applications/pending`);
export const uploadAttachment = (p: string, file: { name: string; mediaType: string; base64: string }) => getHttpClient().request<Attachment>(`${root(p)}/attachments`, { method: 'POST', body: file });
export const openEvents = (p: string, id: string, signal: AbortSignal) => getHttpClient().requestStream(`${root(p)}/turns/${encodeURIComponent(id)}/events`, { signal, suppressUnauthorized: true });

/** A reconnect replaces the current version. Split UTF-8 and CRLF are valid; oversized frames fail closed. */
export async function consumeEvents(response: Response, publish: (turn: ReturnType<typeof parseTurn>) => void, signal: AbortSignal) {
  if (!response.body) throw new Error('Missing assistant stream');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read(); if (chunk.done) { decoder.decode(); break; }
      // Normalize after concatenation so a CRLF split between network chunks stays valid.
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      if (buffer.length > 4 * 1024 * 1024) throw new Error('Assistant stream limit exceeded');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = frame.split('\n').find(l => l.startsWith('event:'))?.slice(6).trim();
        if (event === 'auth.revoked') throw new Error('AUTH_REVOKED');
        if (event === 'snapshot') {
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!signal.aborted) publish(parseTurn(JSON.parse(data)));
        }
      }
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
