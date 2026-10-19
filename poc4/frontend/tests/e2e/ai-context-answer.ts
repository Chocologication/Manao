import assert from 'node:assert/strict';

/** The two context-acceptance rounds must preserve the book identifier and remembered marker. */
export function assertConversationBookAnswer(answer: string, bookId: number, marker: string): void {
  const actual: unknown = JSON.parse(answer);
  assert.deepEqual(actual, { bookId, marker });
}
