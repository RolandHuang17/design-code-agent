'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  FractionError,
  gcd,
  reduce,
  fromParts,
  parseFraction,
  equals,
  format,
} = require('../lib/fraction');

test('gcd returns the greatest common divisor of two integers', () => {
  assert.strictEqual(gcd(12, 18), 6);
  assert.strictEqual(gcd(18, 12), 6);
  assert.strictEqual(gcd(7, 5), 1);
  assert.strictEqual(gcd(0, 5), 5);
  assert.strictEqual(gcd(5, 0), 5);
  assert.strictEqual(gcd(-12, 18), 6);
  assert.strictEqual(gcd(0, 0), 0);
});

test('reduce normalizes sign so the denominator is always positive', () => {
  assert.deepStrictEqual(reduce(3, -4), { numerator: -3, denominator: 4 });
  assert.deepStrictEqual(reduce(-3, -4), { numerator: 3, denominator: 4 });
});

test('reduce produces a canonical reduced form', () => {
  assert.deepStrictEqual(reduce(2, 4), { numerator: 1, denominator: 2 });
  assert.deepStrictEqual(reduce(6, 8), { numerator: 3, denominator: 4 });
  assert.deepStrictEqual(reduce(0, 5), { numerator: 0, denominator: 1 });
});

test('reduce throws a typed error for a zero denominator', () => {
  assert.throws(
    () => reduce(1, 0),
    (err) => err instanceof FractionError && err.code === 'ZERO_DENOMINATOR'
  );
});

test('reduce throws a typed error for non-safe-integer parts', () => {
  assert.throws(
    () => reduce(1.5, 2),
    (err) => err instanceof FractionError && err.code === 'INVALID_FRACTION'
  );
  assert.throws(
    () => reduce('1', 2),
    (err) => err instanceof FractionError && err.code === 'INVALID_FRACTION'
  );
});

test('fromParts delegates to reduce', () => {
  assert.deepStrictEqual(fromParts(2, 4), { numerator: 1, denominator: 2 });
});

test('parseFraction accepts a plain fraction', () => {
  assert.deepStrictEqual(parseFraction('3/4'), { numerator: 3, denominator: 4 });
});

test('parseFraction normalizes fractional equality (2/4 === 1/2)', () => {
  assert.deepStrictEqual(parseFraction('2/4'), parseFraction('1/2'));
});

test('parseFraction accepts whole numbers as integer/1', () => {
  assert.deepStrictEqual(parseFraction('7'), { numerator: 7, denominator: 1 });
});

test('parseFraction accepts mixed numbers', () => {
  assert.deepStrictEqual(parseFraction('1 1/2'), { numerator: 3, denominator: 2 });
});

test('parseFraction accepts negative fractions', () => {
  assert.deepStrictEqual(parseFraction('-3/4'), { numerator: -3, denominator: 4 });
  assert.deepStrictEqual(parseFraction('3/-4'), { numerator: -3, denominator: 4 });
});

test('parseFraction accepts zero', () => {
  assert.deepStrictEqual(parseFraction('0/5'), { numerator: 0, denominator: 1 });
});

test('parseFraction rejects malformed input (empty, non-string, bad numeric)', () => {
  for (const bad of ['', 'abc', '1/2/3', '1/  ', '1/ 2/ 3']) {
    assert.throws(
      () => parseFraction(bad),
      (err) => err instanceof FractionError && err.code === 'INVALID_FRACTION',
      `expected "${bad}" to be rejected`
    );
  }
  assert.throws(
    () => parseFraction(5),
    (err) => err instanceof FractionError && err.code === 'INVALID_FRACTION'
  );
});

test('parseFraction rejects a zero denominator in string form', () => {
  assert.throws(
    () => parseFraction('1/0'),
    (err) => err instanceof FractionError && err.code === 'ZERO_DENOMINATOR'
  );
});

test('parseFraction rejects an improper mixed number fraction part', () => {
  assert.throws(
    () => parseFraction('1 3/2'),
    (err) => err instanceof FractionError && err.code === 'INVALID_FRACTION'
  );
});

test('equals compares canonical forms', () => {
  const a = fromParts(2, 4);
  const b = fromParts(1, 2);
  const c = fromParts(3, 4);
  assert.strictEqual(equals(a, b), true);
  assert.strictEqual(equals(a, c), false);
});

test('format renders canonical fractions readably', () => {
  assert.strictEqual(format(fromParts(3, 2)), '1 1/2');
  assert.strictEqual(format(fromParts(1, 2)), '1/2');
  assert.strictEqual(format(fromParts(4, 2)), '2');
  assert.strictEqual(format(fromParts(-3, 2)), '-1 1/2');
});

test('parseFraction accepts a single reduced fraction from seed-style input', () => {
  // Seed answers must be valid single fractions accepted by the same validator.
  const seeds = ['1/2', '3/4', '2/3', '5/8', '1/4'];
  for (const s of seeds) {
    const parsed = parseFraction(s);
    assert.ok(Number.isSafeInteger(parsed.numerator));
    assert.ok(parsed.denominator > 0);
  }
});