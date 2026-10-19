import { describe, expect, it } from 'vitest';
import { parseConversationView, parseHistoryPage } from './agentConversation';

const view = { conversationId: 'a', title: '中文😀', headSeq: 3, lastTaskId: null, activeTaskId: null,
  usage: null, compactRequestId: null, compactState: null, compactFailureCode: null };
const item = { seq: 3, taskId: 'task-original', kind: 'assistant', text: '<script>中文😀</script>', toolCallId: null, textOffset: 0 };
describe('conversation browser boundary', () => {
  it('constructs safe DTOs and preserves literal text and zero offset', () => {
    expect(parseConversationView({ ...view, header: { private: true } })).toEqual(view);
    expect(parseHistoryPage({ items: [{ ...item, thinking: 'private', entry: { raw: true } }], nextBeforeSeq: 3, nextBeforeOffset: 0 }))
      .toEqual({ items: [item], nextBeforeSeq: 3, nextBeforeOffset: 0 });
  });
  it('keeps unknown usage unknown even when a percentage was supplied', () => {
    expect(parseConversationView({ ...view, usage: { tokens: null, contextWindow: 1048576, percent: 90 } }).usage)
      .toEqual({ tokens: null, contextWindow: 1048576, percent: null });
  });
  it.each(['thinking', 'system', 'context_edit'])('rejects internal history kind %s', kind => {
    expect(() => parseHistoryPage({ items: [{ ...item, kind }], nextBeforeSeq: null, nextBeforeOffset: null })).toThrow();
  });
  it('refuses malformed cursors and unsafe numeric offsets', () => {
    expect(() => parseHistoryPage({ items: [], nextBeforeSeq: null, nextBeforeOffset: 1 })).toThrow();
    expect(() => parseHistoryPage({ items: [{ ...item, textOffset: -1 }], nextBeforeSeq: null, nextBeforeOffset: null })).toThrow();
    expect(() => parseConversationView({ ...view, headSeq: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});
