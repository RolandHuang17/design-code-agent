const ABSOLUTE_ZERO = {
  C: -273.15,
  F: -459.67,
  K: 0
};

const SUPPORTED_UNITS = new Set(['C', 'F', 'K']);

// Insignificant floating-point error allowed at absolute-zero boundaries.
const TOLERANCE = 1e-9;

function isNumericValue(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSupportedUnit(unit) {
  return typeof unit === 'string' && SUPPORTED_UNITS.has(unit);
}

/**
 * Validate a payload of {value, from, to}. Returns normalized {value, from, to}
 * or throws an Error with a nonempty message.
 */
export function validate(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid request payload');
  }

  if (!('value' in payload)) {
    throw new Error('Missing required field: value');
  }
  if (!('from' in payload)) {
    throw new Error('Missing required field: from');
  }
  if (!('to' in payload)) {
    throw new Error('Missing required field: to');
  }

  const { value, from, to } = payload;

  if (!isNumericValue(value)) {
    throw new Error('Value must be a number');
  }

  if (!isSupportedUnit(from)) {
    throw new Error('Unsupported source unit');
  }
  if (!isSupportedUnit(to)) {
    throw new Error('Unsupported destination unit');
  }

  if (value < ABSOLUTE_ZERO[from] - TOLERANCE) {
    throw new Error('Temperature below absolute zero');
  }

  return { value, from, to };
}

/**
 * Convert a numeric value from one temperature unit to another.
 * Returns {value, unit}.
 */
export function convert(value, from, to) {
  const { value: v, from: f, to: t } = validate({ value, from, to });

  if (f === t) {
    return { value: v, unit: t };
  }

  // Convert source to Celsius first.
  let celsius;
  if (f === 'C') {
    celsius = v;
  } else if (f === 'F') {
    celsius = (v - 32) * 5 / 9;
  } else {
    celsius = v - 273.15;
  }

  // Convert Celsius to destination.
  let result;
  if (t === 'C') {
    result = celsius;
  } else if (t === 'F') {
    result = celsius * 9 / 5 + 32;
  } else {
    result = celsius + 273.15;
  }

  return { value: result, unit: t };
}
