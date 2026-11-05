/**
 * Unit tests for exact rational arithmetic (fraction.js).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseFraction,
  reduce,
  gcd,
  fractionsEqual,
  formatFraction,
  isValidFraction
} = require('../src/fraction');

test('parseFraction parses simple fractions', () => {
  assert.deepEqual(parseFraction('1/2'), { numerator: 1n, denominator: 2n });
  assert.deepEqual(parseFraction('3/4'), { numerator: 3n, denominator: 4n });
});

test('parseFraction parses integers as a/1', () => {
  assert.deepEqual(parseFraction('5'), { numerator: 5n, denominator: 1n });
  assert.deepEqual(parseFraction('-7'), { numerator: -7n, denominator: 1n });
});

test('parseFraction normalizes negative denominators', () => {
  assert.deepEqual(parseFraction('1/-2'), { numerator: -1n, denominator: 2n });
  assert.deepEqual(parseFraction('-1/-2'), { numerator: 1n, denominator: 2n });
});

test('parseFraction handles whitespace', () => {
  assert.deepEqual(parseFraction(' 1 / 2 '), { numerator: 1n, denominator: 2n });
  assert.deepEqual(parseFraction('  3  '), { numerator: 3n, denominator: 1n });
});

test('parseFraction rejects zero denominator', () => {
  assert.throws(() => parseFraction('1/0'), /Denominator cannot be zero/);
});

test('parseFraction rejects malformed input', () => {
  assert.throws(() => parseFraction('abc'), /Malformed fraction/);
  assert.throws(() => parseFraction('1/2/3'), /Malformed fraction/);
  assert.throws(() => parseFraction('1.5/2'), /Malformed fraction/);
  assert.throws(() => parseFraction(''), /Empty fraction/);
  assert.throws(() => parseFraction('1/'), /Malformed fraction/);
});

test('parseFraction rejects non-string input', () => {
  assert.throws(() => parseFraction(42), /must be a string/);
  assert.throws(() => parseFraction(null), /must be a string/);
});

test('gcd computes greatest common divisor', () => {
  assert.equal(gcd(12n, 8n), 4n);
  assert.equal(gcd(7n, 5n), 1n);
  assert.equal(gcd(0n, 5n), 5n);
  assert.equal(gcd(-12n, 8n), 4n);
  assert.equal(gcd(6n, 0n), 6n);
});

test('reduce simplifies fractions', () => {
  assert.deepEqual(reduce({ numerator: 2n, denominator: 4n }), {
    numerator: 1n,
    denominator: 2n
  });
  assert.deepEqual(reduce({ numerator: 6n, denominator: 9n }), {
    numerator: 2n,
    denominator: 3n
  });
  assert.deepEqual(reduce({ numerator: -4n, denominator: 8n }), {
    numerator: -1n,
    denominator: 2n
  });
});

test('fractionsEqual treats equivalent fractions as equal', () => {
  assert.equal(fractionsEqual('1/2', '2/4'), true);
  assert.equal(fractionsEqual('2/4', '1/2'), true);
  assert.equal(fractionsEqual('3/9', '1/3'), true);
  assert.equal(fractionsEqual('5', '5/1'), true);
  assert.equal(fractionsEqual('0', '0/5'), true);
});

test('fractionsEqual distinguishes different values', () => {
  assert.equal(fractionsEqual('1/2', '1/3'), false);
  assert.equal(fractionsEqual('1/2', '2/5'), false);
  assert.equal(fractionsEqual('1', '2'), false);
});

test('fractionsEqual accepts objects', () => {
  assert.equal(
    fractionsEqual({ numerator: 2n, denominator: 4n }, { numerator: 1n, denominator: 2n }),
    true
  );
  assert.equal(
    fractionsEqual({ numerator: 1n, denominator: 2n }, { numerator: 1n, denominator: 3n }),
    false
  );
});

test('formatFraction renders reduced form', () => {
  assert.equal(formatFraction({ numerator: 2n, denominator: 4n }), '1/2');
  assert.equal(formatFraction({ numerator: 4n, denominator: 2n }), '2');
  assert.equal(formatFraction({ numerator: -2n, denominator: 4n }), '-1/2');
});

test('isValidFraction validates well-formed input', () => {
  assert.equal(isValidFraction('1/2'), true);
  assert.equal(isValidFraction('5'), true);
  assert.equal(isValidFraction('-3/4'), true);
  assert.equal(isValidFraction('1/0'), false);
  assert.equal(isValidFraction('abc'), false);
  assert.equal(isValidFraction(''), false);
  assert.equal(isValidFraction('1/2/3'), false);
});