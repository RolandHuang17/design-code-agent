'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  gcd,
  normalize,
  parseFraction,
  formatFraction,
  toFraction,
  equals,
  compare,
  add,
  subtract,
  multiply,
  divide,
  validateAnswer,
} = require('../src/shared/fraction');

test('parseFraction accepts an integer', () => {
  assert.deepEqual(parseFraction('3'), { numerator: 3, denominator: 1 });
  assert.deepEqual(parseFraction('-7'), { numerator: -7, denominator: 1 });
});

test('parseFraction normalizes simple fractions', () => {
  assert.deepEqual(parseFraction('2/4'), { numerator: 1, denominator: 2 });
  assert.deepEqual(parseFraction('-3/4'), { numerator: -3, denominator: 4 });
  // sign on the denominator is carried to the numerator
  assert.deepEqual(parseFraction('5/-6'), { numerator: -5, denominator: 6 });
});

test('parseFraction accepts mixed numbers', () => {
  assert.deepEqual(parseFraction('1 1/2'), { numerator: 3, denominator: 2 });
  assert.deepEqual(parseFraction('-2 3/4'), { numerator: -11, denominator: 4 });
});

test('parseFraction rejects malformed and invalid input', () => {
  assert.equal(parseFraction('1/0'), null);
  assert.equal(parseFraction('abc'), null);
  assert.equal(parseFraction(''), null);
  assert.equal(parseFraction('   '), null);
  assert.equal(parseFraction('1/2/3'), null);
  assert.equal(parseFraction(null), null);
  assert.equal(parseFraction(5), null);
  assert.equal(parseFraction('1 /'), null);
});

test('formatFraction produces canonical strings', () => {
  assert.equal(formatFraction({ numerator: 1, denominator: 2 }), '1/2');
  assert.equal(formatFraction({ numerator: 2, denominator: 4 }), '1/2');
  assert.equal(formatFraction({ numerator: 4, denominator: 1 }), '4');
  assert.equal(formatFraction({ numerator: 0, denominator: 7 }), '0');
  assert.equal(formatFraction({ numerator: 1, denominator: 0 }), null);
  assert.equal(formatFraction(null), null);
});

test('equals compares equivalent fraction representations exactly', () => {
  assert.equal(equals('1/2', '2/4'), true);
  assert.equal(equals({ numerator: 1, denominator: 2 }, '3/6'), true);
  assert.equal(equals('1/2', '3/4'), false);
  assert.equal(equals('1/2', 'not-a-fraction'), false);
});

test('compare orders fractions exactly', () => {
  assert.equal(compare('1/2', '2/4'), 0);
  assert.equal(compare('1/3', '1/2'), -1);
  assert.equal(compare('3/4', '1/2'), 1);
  assert.ok(Number.isNaN(compare('x', '1/2')));
});

test('arithmetic operations are exact and normalized', () => {
  assert.deepEqual(add('1/4', '1/4'), { numerator: 1, denominator: 2 });
  assert.deepEqual(subtract('3/4', '1/4'), { numerator: 1, denominator: 2 });
  assert.deepEqual(multiply('2/3', '3/4'), { numerator: 1, denominator: 2 });
  assert.deepEqual(divide('1/2', '1/4'), { numerator: 2, denominator: 1 });
  assert.equal(divide('1/2', '0'), null);
});

test('gcd returns a positive divisor and handles zero', () => {
  assert.equal(gcd(12, 8), 4);
  assert.equal(gcd(-12, 8), 4);
  assert.equal(gcd(0, 5), 5);
  assert.equal(gcd(0, 0), 1);
});

test('normalize returns null for a zero denominator', () => {
  assert.equal(normalize(1, 0), null);
  assert.deepEqual(normalize(-4, -8), { numerator: 1, denominator: 2 });
});

test('toFraction coerces strings and objects and rejects bad values', () => {
  assert.deepEqual(toFraction('2/4'), { numerator: 1, denominator: 2 });
  assert.deepEqual(toFraction({ numerator: 2, denominator: 4 }), { numerator: 1, denominator: 2 });
  assert.equal(toFraction({ numerator: 1.5, denominator: 2 }), null);
  assert.equal(toFraction(null), null);
  assert.equal(toFraction(42), null);
});

test('validateAnswer scores exact rational equivalence', () => {
  const question = { correctAnswer: '1/2' };
  assert.deepEqual(validateAnswer(question, '2/4'), { correct: true });
  assert.deepEqual(validateAnswer(question, '1/2'), { correct: true });
  assert.deepEqual(validateAnswer(question, '3/4'), { correct: false });
});

test('validateAnswer handles malformed answers and missing correct answers', () => {
  assert.deepEqual(validateAnswer({ correctAnswer: '1/2' }, 'not-a-fraction'), {
    correct: false,
    reason: 'answer_malformed',
  });
  assert.deepEqual(validateAnswer({ correctAnswer: 'bad' }, '1/2'), {
    correct: false,
    reason: 'question_correct_answer_invalid',
  });
  assert.deepEqual(validateAnswer({}, '1/2'), {
    correct: false,
    reason: 'question_correct_answer_missing',
  });
  assert.deepEqual(validateAnswer({ correctAnswer: '1/2' }, 5), {
    correct: false,
    reason: 'answer_not_string',
  });
});