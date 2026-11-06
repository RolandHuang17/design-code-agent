export const SUPPORTED_UNITS = ['C', 'F', 'K'];

// Absolute zero bounds expressed in each source unit.
const ABSOLUTE_ZERO = {
  C: -273.15,
  F: -459.67,
  K: 0,
};

// Tolerates insignificant floating-point error near the absolute-zero boundary.
const EPSILON = 1e-9;

export function isSupportedUnit(unit) {
  return SUPPORTED_UNITS.includes(unit);
}

export function toCelsius(value, from) {
  switch (from) {
    case 'C':
      return value;
    case 'F':
      return (value - 32) * 5 / 9;
    case 'K':
      return value - 273.15;
    default:
      throw new Error(`Unsupported unit: ${from}`);
  }
}

export function fromCelsius(celsius, to) {
  switch (to) {
    case 'C':
      return celsius;
    case 'F':
      return celsius * 9 / 5 + 32;
    case 'K':
      return celsius + 273.15;
    default:
      throw new Error(`Unsupported unit: ${to}`);
  }
}

/**
 * Validates the input fields for a conversion request.
 * Returns { ok: true } or { ok: false, error: string }.
 */
export function validateInput(value, from, to) {
  if (!isSupportedUnit(from) || !isSupportedUnit(to)) {
    return { ok: false, error: 'Unsupported unit' };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: 'Value must be a finite number' };
  }
  // Reject temperatures below absolute zero, allowing floating-point tolerance.
  if (value < ABSOLUTE_ZERO[from] - EPSILON) {
    return { ok: false, error: 'Value is below absolute zero' };
  }
  return { ok: true };
}

/**
 * Converts a temperature from one unit to another.
 * Throws on invalid input; callers may validate first via validateInput().
 */
export function convert(value, from, to) {
  const validation = validateInput(value, from, to);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  if (from === to) {
    return value;
  }
  const celsius = toCelsius(value, from);
  return fromCelsius(celsius, to);
}