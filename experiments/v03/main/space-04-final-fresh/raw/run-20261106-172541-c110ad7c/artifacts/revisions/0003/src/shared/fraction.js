'use strict';

/**
 * Shared domain utilities for the Space Fractions system.
 *
 * Exact rational arithmetic for sixth-grade fraction answers. No external
 * services and no floating point: fractions are represented as normalized
 * { numerator, denominator } pairs of arbitrary-precision-ish integers
 * (Node's number type, but arithmetic kept exact by normalizing before and
 * after each operation).
 *
 * Grammar (implementation-defined, origin=assumption):
 *   - integer:            "3", "-3"
 *   - simple fraction:    "1/2", "-3/4", "5/-6" (sign may prefix numerator
 *                         or denominator)
 *   - mixed number:       "1 1/2", "-2 3/4"
 *
 * parseFraction returns an invalid sentinel (null) rather than throwing so
 * callers can distinguish a 400 (malformed fraction) from other errors.
 */

const MATH_ERROR = 'Division by zero';

/**
 * Greatest common divisor (Euclid, non-negative operands).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

/**
 * Reduce a fraction to lowest terms with a positive denominator, carrying the
 * sign on the numerator. Returns null if the denominator is zero.
 *
 * @param {number} numerator
 * @param {number} denominator
 * @returns {{numerator:number, denominator:number}|null}
 */
function normalize(numerator, denominator) {
  if (denominator === 0) return null;
  let n = numerator;
  let d = denominator;
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { numerator: n / g, denominator: d / g };
}

/**
 * Parse a fraction string into a normalized exact rational pair.
 * Accepts integers, simple fractions and mixed numbers.
 *
 * @param {string} input
 * @returns {{numerator:number, denominator:number}|null} null when invalid
 */
function parseFraction(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text === '') return null;

  const INVALID = null;
  const INT = /^[+-]?\d+$/;
  const FRAC = /^([+-]?\d+)\/([+-]?\d+)$/;
  const MIXED = /^([+-]?\d+)\s+(\d+)\/(\d+)$/;

  if (INT.test(text)) {
    return normalize(Number(text), 1);
  }

  const frac = FRAC.exec(text);
  if (frac) {
    return normalize(Number(frac[1]), Number(frac[2]));
  }

  const mixed = MIXED.exec(text);
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (den === 0) return INVALID;
    const sign = whole < 0 ? -1 : 1;
    const absWhole = Math.abs(whole);
    return normalize(sign * (absWhole * den + num), den);
  }

  return INVALID;
}

/**
 * Format a normalized fraction pair as a canonical string ("a/b", or "a" for a
 * unit denominator). Returns null for an invalid pair (zero denominator).
 *
 * @param {{numerator:number, denominator:number}} f
 * @returns {string|null}
 */
function formatFraction(f) {
  if (!f || typeof f !== 'object') return null;
  const n = normalize(f.numerator, f.denominator);
  if (!n) return null;
  if (n.denominator === 1) return String(n.numerator);
  return `${n.numerator}/${n.denominator}`;
}

/**
 * Exact equality of two fractions. Accepts either { numerator, denominator }
 * objects or fraction strings ("1/2" equals "2/4").
 *
 * @param {object|string} a
 * @param {object|string} b
 * @returns {boolean}
 */
function equals(a, b) {
  const fa = toFraction(a);
  const fb = toFraction(b);
  if (!fa || !fb) return false;
  return fa.numerator === fb.numerator && fa.denominator === fb.denominator;
}

/**
 * Exact comparison. Returns -1, 0, or 1 (a < b, a === b, a > b).
 *
 * @param {object|string} a
 * @param {object|string} b
 * @returns {number}
 */
function compare(a, b) {
  const fa = toFraction(a);
  const fb = toFraction(b);
  if (!fa || !fb) return NaN;
  const lhs = fa.numerator * fb.denominator;
  const rhs = fb.numerator * fa.denominator;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

/**
 * Exact addition. Returns a normalized pair or null on invalid input.
 *
 * @param {object|string} a
 * @param {object|string} b
 * @returns {{numerator:number, denominator:number}|null}
 */
function add(a, b) {
  const fa = toFraction(a);
  const fb = toFraction(b);
  if (!fa || !fb) return null;
  return normalize(
    fa.numerator * fb.denominator + fb.numerator * fa.denominator,
    fa.denominator * fb.denominator,
  );
}

/**
 * Exact subtraction (a - b). Returns a normalized pair or null.
 *
 * @param {object|string} a
 * @param {object|string} b
 * @returns {{numerator:number, denominator:number}|null}
 */
function subtract(a, b) {
  const fb = toFraction(b);
  if (!fb) return null;
  return add(a, { numerator: -fb.numerator, denominator: fb.denominator });
}

/**
 * Exact multiplication. Returns a normalized pair or null.
 *
 * @param {object|string} a
 * @param {object|string} b
 * @returns {{numerator:number, denominator:number}|null}
 */
function multiply(a, b) {
  const fa = toFraction(a);
  const fb = toFraction(b);
  if (!fa || !fb) return null;
  return normalize(fa.numerator * fb.numerator, fa.denominator * fb.denominator);
}

/**
 * Exact division (a / b). Returns a normalized pair or null (including when
 * the divisor is zero).
 *
 * @param {object|string} a
 * @param {object|string} b
 * @returns {{numerator:number, denominator:number}|null}
 */
function divide(a, b) {
  const fa = toFraction(a);
  const fb = toFraction(b);
  if (!fa || !fb) return null;
  if (fb.numerator === 0) return null;
  return normalize(fa.numerator * fb.denominator, fa.denominator * fb.numerator);
}

/**
 * Coerce a fraction object or string to a normalized pair.
 * @param {object|string} value
 * @returns {{numerator:number, denominator:number}|null}
 */
function toFraction(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return parseFraction(value);
  if (typeof value === 'object') {
    if (typeof value.numerator !== 'number' || typeof value.denominator !== 'number') return null;
    if (!Number.isInteger(value.numerator) || !Number.isInteger(value.denominator)) return null;
    return normalize(value.numerator, value.denominator);
  }
  return null;
}

/**
 * Pure question-answer scoring validator.
 *
 * Determines whether a submitted answer equals the question's correct answer
 * using exact rational comparison. Used by the game service to decide a single
 * point without exposing the correct answer to players.
 *
 * @param {{correctAnswer: string, options?: string[]}} question
 * @param {string} answer submitted answer string
 * @returns {{correct: boolean, reason?: string}}
 */
function validateAnswer(question, answer) {
  if (!question || typeof question.correctAnswer !== 'string') {
    return { correct: false, reason: 'question_correct_answer_missing' };
  }
  if (typeof answer !== 'string') {
    return { correct: false, reason: 'answer_not_string' };
  }

  const correct = parseFraction(question.correctAnswer);
  if (!correct) {
    return { correct: false, reason: 'question_correct_answer_invalid' };
  }

  const submitted = parseFraction(answer);
  if (!submitted) {
    return { correct: false, reason: 'answer_malformed' };
  }

  return {
    correct: correct.numerator === submitted.numerator && correct.denominator === submitted.denominator,
  };
}

module.exports = {
  MATH_ERROR,
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
};