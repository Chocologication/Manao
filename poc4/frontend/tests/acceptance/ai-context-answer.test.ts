import { expect, it } from 'vitest';
import { assertConversationBookAnswer } from '../e2e/ai-context-answer';

const marker = 'original-marker';
it.each([7, 8])('accepts the exact raw JSON for round bookId %i', bookId => {
  expect(() => assertConversationBookAnswer(JSON.stringify({ bookId, marker }), bookId, marker)).not.toThrow();
});
it.each([7, 8])('rejects an id field with bookId mentioned only in a note in round %i', bookId => {
  const wrong = JSON.stringify({ id: bookId, note: 'the requested key was bookId', marker });
  expect(() => assertConversationBookAnswer(wrong, bookId, marker)).toThrow();
});
it.each([
  'Use bookId, remembered marker is original-marker.',
  '{"bookId":7,"marker":"original-marker"',
  '{"bookId":8,"marker":"original-marker"}',
  '{"bookId":7,"marker":"wrong-marker"}',
  '{"bookId":7,"id":7,"marker":"original-marker"}',
])('rejects prose, malformed JSON, wrong values and extra identifier fields: %s', answer => {
  expect(() => assertConversationBookAnswer(answer, 7, marker)).toThrow();
});
