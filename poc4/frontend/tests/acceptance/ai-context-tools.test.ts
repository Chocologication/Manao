import { expect, it } from 'vitest';
import { assertConversationTools } from '../e2e/ai-context-answer';

const taskId = 'first-task';
const read = [
  { taskId, kind: 'tool_call', text: 'read_file', toolCallId: 'read-1' },
  { taskId, kind: 'tool_result', text: 'read_file', toolCallId: 'read-1' },
];
it('accepts exactly one paired read_file and returns its original call ID', () => {
  expect(assertConversationTools(read, taskId, 'read_file')).toBe('read-1');
});
it('rejects a correct read followed by an additional write_file call and result', () => {
  expect(() => assertConversationTools([...read,
    { taskId, kind: 'tool_call', text: 'write_file', toolCallId: 'write-2' },
    { taskId, kind: 'tool_result', text: 'write_file', toolCallId: 'write-2' },
  ], taskId, 'read_file')).toThrow();
});
it.each(['tool_call', 'tool_result'])('rejects a correct JSON answer with an extra %s in any later round', kind => {
  const items = [
    { taskId, kind: 'assistant', text: '{"bookId":8,"marker":"original-marker"}', toolCallId: null },
    { taskId, kind, text: 'application', toolCallId: 'app-1' },
  ];
  expect(() => assertConversationTools(items, taskId, null)).toThrow();
});
it.each([
  [read[1]!],
  [read[0]!, { ...read[1]!, toolCallId: 'other-call' }],
  [{ ...read[0]!, text: 'write_file' }, read[1]!],
  [{ ...read[0]!, toolCallId: null }, { ...read[1]!, toolCallId: null }],
  [read[0]!, { ...read[1]!, taskId: 'other-task' }],
].map(items => ({ items })))('rejects missing calls, mismatched names/IDs and cross-task results: %j', ({ items }) => {
  expect(() => assertConversationTools(items, taskId, 'read_file')).toThrow();
});
it('accepts a tool-free round while ignoring earlier task tools and compact metadata', () => {
  expect(assertConversationTools([...read,
    { taskId: 'later-task', kind: 'assistant', text: '{"bookId":8,"marker":"original-marker"}', toolCallId: null },
    { taskId: null, kind: 'compaction', text: '上下文已压缩', toolCallId: null },
  ], 'later-task', null)).toBeNull();
});
