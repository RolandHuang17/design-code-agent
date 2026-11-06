import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePort } from '../src/server.js';

test('resolvePort defaults to 3000 when PORT is unset', () => {
  assert.equal(resolvePort({}), 3000);
});

test('resolvePort defaults to 3000 when PORT is empty', () => {
  assert.equal(resolvePort({ PORT: '' }), 3000);
});

test('resolvePort uses a valid PORT value', () => {
  assert.equal(resolvePort({ PORT: '4123' }), 4123);
});

test('resolvePort falls back to 3000 for an invalid PORT value', () => {
  assert.equal(resolvePort({ PORT: 'not-a-number' }), 3000);
  assert.equal(resolvePort({ PORT: '-5' }), 3000);
  assert.equal(resolvePort({ PORT: '0' }), 3000);
});