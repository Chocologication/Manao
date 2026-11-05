import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from './app.js';
test('greets the user', () => { assert.equal(greet('Manao'), 'Hello, Manao!'); });
test('has a default greeting', () => { assert.equal(greet(), 'Hello, Manao!'); });
