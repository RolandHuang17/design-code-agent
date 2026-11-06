// Pure temperature conversion and validation module.
// No HTTP or I/O dependency: this module is fully self-contained (NFR1).

// Absolute zero boundaries for each supported unit (FR4).
export const ABSOLUTE_ZERO = Object.freeze({
  C: -273.15,
  F: -459.67,
  K: 0,
});

// Supported units.
export const UNITS = Object.freeze(['C', 'F', 'K']);

// Tolerance for insignificant floating-point error at the absolute-zero
// boundaries described in FR4.
const EPSILON = 1e-9;

/**
 * Validate a value/from/to triple. Returns an error message string when the
 * triple is invalid, or null when it is valid.
 *
 * - value must be a finite number (rejects missing, booleans, strings, NaN,
 *   and infinities).
 * - from and to must be one of C, F, K.
 * - value must not be below absolute zero for the `from` unit (FR4), allowing
 *   insignificant floating-point error at the exact boundary.
 */
export function validate(value, from, to) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'value must be a number';
  }
  if (typeof from !== 'string' || !UNITS.includes(from)) {
    return 'unsupported source unit';
  }
  if (typeof to !== 'string' || !UNITS.includes(to)) {
    return 'unsupported destination unit';
  }
  // Allow insignificant floating-point error at the boundary (FR4).
  if (value < ABSOLUTE_ZERO[from] - EPSILON) {
    return 'temperature below absolute zero';
  }
  return null;
}

/**
 * Convert a temperature value from one unit to another (FR3).
 *
 * Throws an Error with a nonempty message when the input is invalid
 * (see {validate}). Same-unit conversion preserves the value.
 */
export function convert(value, from, to) {
  const error = validate(value, from, to);
  if (error !== null) {
    throw new Error(error);
  }

  if (from === to) {
    return value;
  }

  // Convert the input to Celsius, then from Celsius to the target unit.
  let celsius;
  switch (from) {
    case 'C':
      celsius = value;
      break;
    case 'F':
      celsius = ((value - 32) * 5) / 9;
      break;
    case 'K':
      celsius = value - 273.15;
      break;
    default:
      // validate() guarantees a supported unit; this cannot be reached.
      throw new Error('unsupported source unit');
  }

  switch (to) {
    case 'C':
      return celsius;
    case 'F':
      return (celsius * 9) / 5 + 32;
    case 'K':
      return celsius + 273.15;
    default:
      // validate() guarantees a supported unit; this cannot be reached.
      throw new Error('unsupported destination unit');
  }
}