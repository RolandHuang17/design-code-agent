'use strict';

/**
 * Exact rational arithmetic utilities for the Space Fractions system.
 *
 * Fractions are represented as `{ numerator, denominator }` BigInt pairs.
 * The denominator is always a positive BigInt and every fraction is
 * normalized to its reduced form (numerator and denominator coprime).
 * A zero value is always represented as `0/1`.
 *
 * This module is pure (no I/O) and is shared by answer validation, seed
 * data generation, and scoring throughout the system, guaranteeing that
 * "1/2" === "2/4" === "3/6" when compared by value.
 */

const MAX_SAFE_DENOMINATOR = 1_000_000;

/**
 * A normalized fraction value plus the text a user typed.
 * @typedef {Object} Fraction
 * @property {bigint} numerator
 * @property {bigint} denominator
 */

/**
 * Custom validation error carrying an HTTP-friendly code and message.
 * Thrown for any malformed fraction or unsafe denominator.
 */
class FractionError extends Error {
  constructor(message, code = 'INVALID_FRACTION') {
    super(message);
    this.name = 'FractionError';
    this.code = code;
  }
}

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/**
 * Reduce a numerator/denominator pair to canonical form.
 * @param {bigint} numerator
 * @param {bigint} denominator
 * @returns {Fraction}
 */
function reduce(numerator, denominator) {
  if (denominator === 0n) {
    throw new FractionError('Fraction denominator cannot be zero.');
  }
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const g = gcd(numerator, denominator);
  return {
    numerator: numerator / g,
    denominator: denominator / g,
  };
}

/**
 * Construct a fraction from BigInt parts, normalizing to reduced form.
 * Throws FractionError on a zero denominator.
 * @param {bigint|number|string} numerator
 * @param {bigint|number|string} denominator
 * @returns {Fraction}
 */
function makeFraction(numerator, denominator) {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d <= 0n) {
    throw new FractionError('Fraction denominator must be a positive integer.');
  }
  return reduce(n, d);
}

/**
 * Parse a user-supplied fraction string. Accepts:
 *   - a plain integer ("3", "-2")
 *   - a rational "n/d" ("1/2", "-3/4")
 *   - a mixed number "w n/d" ("1 1/2")
 *   - a decimal with a bounded denominator ("0.5", "0.333")
 *
 * All whitespace is tolerated. Parsing is exact: decimal inputs are
 * converted via a rational with a power-of-ten denominator and reduced.
 *
 * @param {string} input
 * @returns {Fraction}
 */
function parseFraction(input) {
  if (typeof input !== 'string') {
    throw new FractionError('Fraction answer must be a string.');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new FractionError('Fraction answer must not be empty.');
  }

  const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
  const FRACTION_RE = /^(-?\d+)\s*\/\s*(-?\d+)$/;
  const MIXED_RE = /^(-?\d+)\s+(\d+)\s*\/\s*(\d+)$/;

  if (DECIMAL_RE.test(trimmed)) {
    return parseDecimal(trimmed);
  }

  let m = FRACTION_RE.exec(trimmed);
  if (m) {
    const n = BigInt(m[1]);
    const d = BigInt(m[2]);
    if (d === 0n) {
      throw new FractionError('Fraction denominator cannot be zero.');
    }
    return reduce(n, d);
  }

  m = MIXED_RE.exec(trimmed);
  if (m) {
    const whole = BigInt(m[1]);
    const n = BigInt(m[2]);
    const d = BigInt(m[3]);
    if (d === 0n) {
      throw new FractionError('Fraction denominator cannot be zero.');
    }
    if (n < 0n) {
      throw new FractionError('Mixed number fraction part must be positive.');
    }
    const sign = whole < 0n ? -1n : 1n;
    const absWhole = whole < 0n ? -whole : whole;
    return reduce(sign * (absWhole * d + n), d);
  }

  throw new FractionError(`Unrecognized fraction format: "${input}".`);
}

function parseDecimal(input) {
  const negative = input.startsWith('-');
  const unsigned = negative ? input.slice(1) : input;
  const [wholePart, fracPart = ''] = unsigned.split('.');
  const denominator = 10n ** BigInt(fracPart.length);
  const whole = BigInt(wholePart || '0');
  const frac = BigInt(fracPart || '0');
  const n = (negative ? -1n : 1n) * (whole * denominator + frac);
  return reduce(n, denominator);
}

/**
 * Add two fractions (exact).
 * @param {Fraction} a
 * @param {Fraction} b
 * @returns {Fraction}
 */
function add(a, b) {
  return reduce(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}

/**
 * Subtract b from a (exact).
 * @param {Fraction} a
 * @param {Fraction} b
 * @returns {Fraction}
 */
function subtract(a, b) {
  return reduce(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
}

/**
 * Multiply two fractions (exact).
 * @param {Fraction} a
 * @param {Fraction} b
 * @returns {Fraction}
 */
function multiply(a, b) {
  return reduce(a.numerator * b.numerator, a.denominator * b.denominator);
}

/**
 * Divide a by b (exact). Throws FractionError if b is zero.
 * @param {Fraction} a
 * @param {Fraction} b
 * @returns {Fraction}
 */
function divide(a, b) {
  if (b.numerator === 0n) {
    throw new FractionError('Cannot divide by zero.');
  }
  return reduce(a.numerator * b.denominator, a.denominator * b.numerator);
}

/**
 * Value equality between two normalized fractions. Both inputs must already
 * be normalized (as produced by this module); equality is exact.
 * @param {Fraction} a
 * @param {Fraction} b
 * @returns {boolean}
 */
function eq(a, b) {
  return a.numerator === b.numerator && a.denominator === b.denominator;
}

/**
 * Compare two fractions: -1 if a < b, 0 if equal, 1 if a > b (exact).
 * @param {Fraction} a
 * @param {Fraction} b
 * @returns {number}
 */
function compare(a, b) {
  const lhs = a.numerator * b.denominator;
  const rhs = b.numerator * a.denominator;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

/**
 * Human-readable canonical string, e.g. "1/2", "-3/4", "3".
 * @param {Fraction} f
 * @returns {string}
 */
function toString(f) {
  if (f.denominator === 1n) return f.numerator.toString();
  return `${f.numerator}/${f.denominator}`;
}

/**
 * Validate that a fraction is a safe, correctly-formed answer for a
 * sixth-grade fraction question. Returns true or throws FractionError.
 *
 * Enforces a sane denominator upper bound to reject absurd machine inputs
 * (a plain validation guard, distinct from exact arithmetic correctness).
 * @param {Fraction} f
 * @returns {boolean}
 */
function isValidAnswer(f) {
  if (!f || typeof f.numerator !== 'bigint' || typeof f.denominator !== 'bigint') {
    throw new FractionError('Malformed fraction object.');
  }
  if (f.denominator <= 0n) {
    throw new FractionError('Fraction denominator must be positive.');
  }
  if (f.denominator > BigInt(MAX_SAFE_DENOMINATOR)) {
    throw new FractionError(`Fraction denominator exceeds safe limit of ${MAX_SAFE_DENOMINATOR}.`);
  }
  return true;
}

/**
 * Parse and validate a user-supplied answer string, returning a normalized
 * fraction or throwing FractionError. Combines parse + safety validation.
 * @param {string} input
 * @returns {Fraction}
 */
function parseAnswer(input) {
  const f = parseFraction(input);
  isValidAnswer(f);
  return f;
}

module.exports = {
  FractionError,
  makeFraction,
  parseFraction,
  parseAnswer,
  parseDecimal,
  reduce,
  add,
  subtract,
  multiply,
  divide,
  eq,
  compare,
  toString,
  isValidAnswer,
};