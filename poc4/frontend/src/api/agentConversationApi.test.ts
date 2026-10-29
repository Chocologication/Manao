import { afterEach, expect, it } from 'vitest';
import { compactAgentConversation, getConversationHistory } from './agentConversationApi';
import { HttpClient, setHttpClient } from './httpClient';

afterEach(() => setHttpClient(null));
it('sends the original compaction identity once through the owner-authenticated public route', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const view = { conversationId: 'c', title: 'A', headSeq: 7, lastTaskId: null, activeTaskId: null,
    usage: null, compactRequestId: 'original-request', compactState: 'RUNNING', compactFailureCode: null, nextReasoningEffort: 'high' };
  setHttpClient(new HttpClient({ getAccessToken: () => 'owner-test-token', onUnauthorized: () => {},
    fetchImpl: async (input, init) => { calls.push({ url: String(input), init }); return new Response(JSON.stringify(view)); } }));
  expect(await compactAgentConversation('project/a', 'c', { requestId: 'original-request', expectedHeadSeq: 7 })).toEqual(view);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('/api/v1/projects/project%2Fa/conversations/c/compact');
  expect(calls[0]!.init?.method).toBe('POST');
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ requestId: 'original-request', expectedHeadSeq: 7 });
  expect(new Headers(calls[0]!.init?.headers).get('Authorization')).toBe('Bearer owner-test-token');
});
it('retains the composite cursor and cancellation signal without exposing native fields', async () => {
  let capturedUrl = '', capturedSignal: AbortSignal | null | undefined;
  const abort = new AbortController();
  setHttpClient(new HttpClient({ getAccessToken: () => 'owner-test-token', onUnauthorized: () => {},
    fetchImpl: async (input, init) => { capturedUrl = String(input); capturedSignal = init?.signal;
      return new Response(JSON.stringify({ items: [{ seq: 7, taskId: 't', kind: 'assistant', text: '😀', toolCallId: null, textOffset: 0, contentIndex: 2, modelTruncated: true, payload: 'private' }], nextBeforeSeq: null, nextBeforeOffset: null })); } }));
  const page = await getConversationHistory('p', 'a/b', { beforeSeq: 7, beforeOffset: 0 }, abort.signal);
  expect(capturedUrl).toBe('/api/v1/projects/p/conversations/a%2Fb/entries?limit=50&beforeSeq=7&beforeOffset=0');
  expect(capturedSignal).toBe(abort.signal);
  expect(page.items[0]).toEqual({ seq: 7, taskId: 't', kind: 'assistant', text: '😀', toolCallId: null, textOffset: 0, contentIndex: 2, modelTruncated: true });
});
