import assert from 'node:assert/strict';

/** The two context-acceptance rounds must preserve the book identifier and remembered marker. */
export function assertConversationBookAnswer(answer: string, bookId: number, marker: string): void {
  const actual: unknown = JSON.parse(answer);
  assert.deepEqual(actual, { bookId, marker });
}

type ToolHistoryItem = { taskId: string | null; kind: string; text: string; toolCallId: string | null };
export function assertConversationTools(items: ToolHistoryItem[], taskId: string, expected: 'read_file' | null): string | null {
  const tools = items.filter(i => i.taskId === taskId && (i.kind === 'tool_call' || i.kind === 'tool_result'));
  assert.equal(tools.length, expected === null ? 0 : 2, 'Unexpected tools in read-only context acceptance');
  if (expected === null) return null;
  const call = tools.find(i => i.kind === 'tool_call'), result = tools.find(i => i.kind === 'tool_result');
  assert.ok(call && result, 'Expected one call and its settled result');
  assert.equal(call.text, expected); assert.equal(result.text, expected);
  assert.ok(call.toolCallId); assert.equal(result.toolCallId, call.toolCallId);
  return call.toolCallId;
}
