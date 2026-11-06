'use strict';

// Absolute temperature and temperature unit handling.
//
// Units are limited to C (Celsius), F (Fahrenheit) and K (Kelvin).
// Formulas follow FR3:
//   C = (F - 32) * 5 / 9
//   K = C + 273.15
// Same-unit conversion preserves the value, but still validates against
// absolute zero (FR4).

const VALID_UNITS = new Set(['C', 'F', 'K']);

// Absolute zero expressed in each unit. The boundary is -273.15 C,
// -459.67 F and 0 K (FR4). Floating-point representation cannot express
// -273.15 and -459.67 exactly, so boundary comparisons use an epsilon so
// insignificant rounding error at the boundary is tolerated.
const ABSOLUTE_ZERO = {
  C: -273.15,
  F: -459.67,
  K: 0,
};

// Tolerance for behalf-the-boundary floating-point error (FR4).
const EPSILON = 1e-9;

// Thrown validation failures. The message is a non-empty, human-readable
// string that callers can map to HTTP 400 {error}.
class ConversionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConversionError';
  }
}

function isUnsupportedUnit(unit) {
  return typeof unit !== 'string' || !VALID_UNITS.has(unit);
}

// A value is a valid numeric temperature only if it is a finite number and
// not a boolean. Booleans are explicitly rejected (FR4: booleans).
function isNonNumeric(value) {
  return typeof value !== 'number' || !Number.isFinite(value) || Number.isNaN(value);
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

// Convert a temperature expressed in `from` to the equivalent in `to`.
//
// Returns { value, unit } on success and throws ConversionError on invalid
// input. The returned value is never rounded to an integer.
function convert(value, from, to) {
  if (isUnsupportedUnit(from)) {
    throw new ConversionError('unsupported source unit');
  }
  if (isUnsupportedUnit(to)) {
    throw new ConversionError('unsupported destination unit');
  }
  if (isBoolean(value)) {
    throw new ConversionError('value must be a number, not a boolean');
  }
  if (isNonNumeric(value)) {
    throw new ConversionError('value must be a finite number');
  }

  // FR4: temperatures below absolute zero are rejected for every unit,
  // including same-unit conversions.
  if (value < ABSOLUTE_ZERO[from] - EPSILON) {
    throw new ConversionError('temperature below absolute zero');
  }

  // Same-unit conversion preserves the value (FR3), after the absolute-zero
  // check above.
  if (from === to) {
    return { value, unit: to };
  }

  // Convert via Celsius as the canonical unit.
  let celsius;
  if (from === 'C') {
    celsius = value;
  } else if (from === 'F') {
    celsius = ((value - 32) * 5) / 9;
  } else {
    celsius = value - 273.15;
  }

  let result;
  if (to === 'C') {
    result = celsius;
  } else if (to === 'F') {
    result = (celsius * 9) / 5 + 32;
  } else {
    result = celsius + 273.15;
  }

  return { value: result, unit: to };
}

module.exports = {
  convert,
  ConversionError,
  VALID_UNITS,
  ABSOLUTE_ZERO,
  EPSILON,
};