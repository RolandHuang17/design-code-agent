/**
 * Exact rational arithmetic for fraction answers.
 * Fractions are represented as {numerator, denominator} with denominator > 0.
 * Parses strings like "1/2", "-3/4", "5".
 */

/**
 * Parse a fraction string into {numerator, denominator}.
 * Accepts: "a/b", "-a/b", "a/-b", "a" (becomes a/1).
 * Throws on malformed input or zero denominator.
 */
function parseFraction(str) {
  if (typeof str !== 'string') {
    throw new Error('Fraction must be a string');
  }
  const trimmed = str.trim();
  if (trimmed === '') {
    throw new Error('Empty fraction string');
  }

  // Check for integer
  if (/^-?\d+$/.test(trimmed)) {
    return { numerator: BigInt(trimmed), denominator: 1n };
  }

  // Check for a/b format
  const match = trimmed.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (!match) {
    throw new Error('Malformed fraction: expected "a/b" or integer');
  }

  const num = BigInt(match[1]);
  const den = BigInt(match[2]);

  if (den === 0n) {
    throw new Error('Denominator cannot be zero');
  }

  // Normalize: denominator always positive
  if (den < 0n) {
    return { numerator: -num, denominator: -den };
  }

  return { numerator: num, denominator: den };
}

/**
 * Greatest common divisor for BigInt.
 */
function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/**
 * Reduce a fraction to simplest form.
 */
function reduce(frac) {
  const g = gcd(frac.numerator, frac.denominator);
  return {
    numerator: frac.numerator / g,
    denominator: frac.denominator / g
  };
}

/**
 * Check if two fractions are exactly equal (after reduction).
 * Accepts strings or {numerator, denominator} objects.
 */
function fractionsEqual(a, b) {
  const fa = typeof a === 'string' ? reduce(parseFraction(a)) : reduce({ numerator: BigInt(a.numerator), denominator: BigInt(a.denominator) });
  const fb = typeof b === 'string' ? reduce(parseFraction(b)) : reduce({ numerator: BigInt(b.numerator), denominator: BigInt(b.denominator) });
  return fa.numerator === fb.numerator && fa.denominator === fb.denominator;
}

/**
 * Format a fraction as string "a/b" or "a" if denominator is 1.
 * Accepts a string ("1/2", "2/4", "5") or an object { numerator, denominator }.
 */
function formatFraction(frac) {
  const parsed = typeof frac === 'string' ? parseFraction(frac) : frac;
  const r = reduce({ numerator: BigInt(parsed.numerator), denominator: BigInt(parsed.denominator) });
  if (r.denominator === 1n) {
    return r.numerator.toString();
  }
  return `${r.numerator}/${r.denominator}`;
}

/**
 * Validate that a string is a well-formed fraction.
 */
function isValidFraction(str) {
  try {
    parseFraction(str);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  parseFraction,
  reduce,
  gcd,
  fractionsEqual,
  formatFraction,
  isValidFraction
};