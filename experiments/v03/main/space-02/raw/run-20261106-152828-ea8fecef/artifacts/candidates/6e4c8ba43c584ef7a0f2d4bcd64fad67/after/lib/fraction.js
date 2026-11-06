'use strict';

/**
 * Exact rational arithmetic for Space Fractions.
 *
 * A fraction is always represented in reduced form as { numerator, denominator }
 * where denominator > 0 and gcd(|numerator|, denominator) === 1. This gives a
 * canonical form so two equal fractions compare equal regardless of how they
 * were entered (e.g. "2/4" === "1/2").
 */
class FractionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FractionError';
    this.code = code || 'INVALID_FRACTION';
  }
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/**
 * Enforce that numerator and denominator are safe integers, denominator non-zero.
 * Returns null when valid, otherwise throws FractionError with a typed code.
 */
function reduce(numerator, denominator) {
  if (
    typeof numerator !== 'number' ||
    typeof denominator !== 'number' ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator)
  ) {
    throw new FractionError('Fraction parts must be safe integers', 'INVALID_FRACTION');
  }
  if (denominator === 0) {
    throw new FractionError('Denominator must not be zero', 'ZERO_DENOMINATOR');
  }

  // Normalize sign so the denominator is always positive.
  if (denominator < 0) {
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
 * Parse a fraction string into a canonical reduced form.
 *
 * Accepted forms parse a single reduced fraction:
 *   "3/4", "-3/4", "3/-4", "0/5", "7" (whole number interpreted as 7/1),
 *   "1 1/2" (mixed number interpreted as 3/2).
 *
 * Rejects anything with more than one '/', multiple terms, or non-numeric parts.
 * Throws FractionError (typed) for malformed input.
 */
function parseFraction(input) {
  if (typeof input !== 'string') {
    throw new FractionError('Fraction must be a string', 'INVALID_FRACTION');
  }

  const trimmed = input.trim();
  if (trimmed === '') {
    throw new FractionError('Fraction must not be empty', 'INVALID_FRACTION');
  }

  const terms = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length > 2) {
    throw new FractionError('Too many terms for a fraction', 'INVALID_FRACTION');
  }

  // A single term that is a pure integer (whole number).
  const integerRe = /^-?\d+$/;

  let whole = 0;
  let num;
  let den = 1;

  if (terms.length === 1) {
    const part = terms[0];
    if (part.includes('/')) {
      const pieces = part.split('/');
      if (pieces.length !== 2) {
        throw new FractionError('Malformed fraction (more than one slash)', 'INVALID_FRACTION');
      }
      const [ns, ds] = pieces;
      if (!integerRe.test(ns) || !integerRe.test(ds)) {
        throw new FractionError('Malformed fraction numerator/denominator', 'INVALID_FRACTION');
      }
      num = Number(ns);
      den = Number(ds);
    } else {
      if (!integerRe.test(part)) {
        throw new FractionError('Malformed fraction', 'INVALID_FRACTION');
      }
      num = Number(part);
    }
  } else {
    // Mixed number: "<whole> <num/den>"
    const [wholePart, fracPart] = terms;
    if (!integerRe.test(wholePart)) {
      throw new FractionError('Malformed mixed number whole part', 'INVALID_FRACTION');
    }
    whole = Number(wholePart);

    if (!fracPart.includes('/')) {
      throw new FractionError('Malformed mixed number fraction part', 'INVALID_FRACTION');
    }
    const pieces = fracPart.split('/');
    if (pieces.length !== 2) {
      throw new FractionError('Malformed mixed number (more than one slash)', 'INVALID_FRACTION');
    }
    const [ns, ds] = pieces;
    if (!integerRe.test(ns) || !integerRe.test(ds)) {
      throw new FractionError('Malformed mixed number fraction', 'INVALID_FRACTION');
    }
    num = Number(ns);
    den = Number(ds);
  }

  if (den === 0) {
    throw new FractionError('Denominator must not be zero', 'ZERO_DENOMINATOR');
  }

  // Collapse mixed number (whole * den + num) / den; sign of whole honored via addition.
  const numerator = whole * den + num;

  // Determine whether the unsigned fraction component is proper for mixed form.
  const fracValue = num / den;
  if (terms.length === 2 && (fracValue < 0 || fracValue >= 1 || Math.abs(num) >= Math.abs(den))) {
    throw new FractionError('Mixed number fraction part must be proper and non-negative', 'INVALID_FRACTION');
  }

  // Denominator sign normalization happens inside reduce to avoid duplicates like "-3/4".
  if (terms.length === 2) {
    return reduce(whole * den + num, den);
  }
  return reduce(numerator, den);
}

/**
 * Canonical reduced form from raw numerator/denominator components.
 */
function fromParts(numerator, denominator) {
  return reduce(numerator, denominator);
}

/**
 * Structural equality on canonical (reduced) fractions.
 */
function equals(a, b) {
  const ra = reduce(a.numerator, a.denominator);
  const rb = reduce(b.numerator, b.denominator);
  return ra.numerator === rb.numerator && ra.denominator === rb.denominator;
}

/**
 * Human-readable string of a canonical fraction, e.g. {3,2} -> "1 1/2".
 */
function format(fraction) {
  const r = reduce(fraction.numerator, fraction.denominator);
  const sign = r.numerator < 0 ? -1 : 1;
  const n = Math.abs(r.numerator);
  const d = r.denominator;
  if (d === 1) {
    return String(sign * n);
  }
  if (n > d) {
    const whole = Math.floor(n / d);
    const rem = n % d;
    if (rem === 0) {
      return String(sign * whole);
    }
    return `${sign * whole} ${rem}/${d}`;
  }
  return `${sign * n}/${d}`;
}

module.exports = {
  FractionError,
  gcd,
  reduce,
  fromParts,
  parseFraction,
  equals,
  format,
};