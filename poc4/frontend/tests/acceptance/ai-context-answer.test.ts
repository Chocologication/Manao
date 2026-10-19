import { expect, it } from 'vitest';
import { assertConversationBookAnswer, assertConversationFixtureRead } from '../e2e/ai-context-answer';

const marker = 'original-marker';
const fixture = { path: 'context-fixture.txt', content: 'abc', workspaceRevision: '12' };
const read = {
  toolCallId: 'fixture-read-1', toolName: 'read_file',
  data: { path: fixture.path, content: 'abc', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
};
it('accepts a complete settled read against the actual public file response without a sha256 field', () => {
  expect(() => assertConversationFixtureRead(fixture, read, fixture.path, read.toolCallId)).not.toThrow();
});
it('hashes exact original content including CRLF bytes', () => {
  const content = 'abc\r\n';
  const result = { ...read, data: { ...read.data, content, sha256: '552bab6864c7a7b69a502ed1854b9245c0e1a30f008aaa0b281da62585fdb025' } };
  expect(() => assertConversationFixtureRead({ ...fixture, content }, result, fixture.path, read.toolCallId)).not.toThrow();
});
it.each([
  { name: 'wrong digest', data: { ...read.data, sha256: '0'.repeat(64) } },
  { name: 'changed content', data: { ...read.data, content: 'abd' } },
  { name: 'changed content with its matching digest', data: { ...read.data, content: 'abd', sha256: 'a52d159f262b2c6ddb724a61840befc36eb30c88877a4030b65cbe86298449c9' } },
  { name: 'wrong path', data: { ...read.data, path: 'other.txt' } },
  { name: 'truncated read', data: { ...read.data, truncated: true } },
  { name: 'changed line endings', data: { ...read.data, content: 'abc\r\n' } },
])('rejects fixture read with $name', ({ data }) => {
  expect(() => assertConversationFixtureRead(fixture, { ...read, data }, fixture.path, read.toolCallId)).toThrow();
});
it.each([
  { ...read, toolCallId: 'other-call' },
  { ...read, toolName: 'write_file' },
])('rejects a fixture result from a different tool or call: %j', result => {
  expect(() => assertConversationFixtureRead(fixture, result, fixture.path, read.toolCallId)).toThrow();
});
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
