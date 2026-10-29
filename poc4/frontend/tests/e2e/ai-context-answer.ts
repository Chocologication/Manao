import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

type WorkspaceContent = { path: string; content: string; workspaceRevision: string };
type FixtureRead = { toolCallId: string; toolName: string; data: { path: string; content: string; sha256: string; truncated?: boolean } };

export function assertConversationFixtureRead(fixture: WorkspaceContent, read: FixtureRead, fixturePath: string, toolCallId: string): void {
  assert.equal(read.toolCallId, toolCallId); assert.equal(read.toolName, 'read_file'); assert.equal(read.data.path, fixturePath);
  assert.equal(read.data.truncated === true, false);
  assert.equal(read.data.sha256, createHash('sha256').update(fixture.content, 'utf8').digest('hex'));
  assert.equal(read.data.content, fixture.content);
  assert.equal(Buffer.byteLength(read.data.content, 'utf8'), Buffer.byteLength(fixture.content, 'utf8'));
}

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
