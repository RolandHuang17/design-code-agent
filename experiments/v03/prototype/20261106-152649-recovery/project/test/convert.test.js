import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convert, validate } from '../src/convert.js';

const EPSILON = 1e-9;

function assertClose(actual, expected, msg) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${msg || 'values differ'}: expected ${expected}, got ${actual}`
  );
}

test('Celsius to Fahrenheit conversion uses the correct formula', () => {
  assertClose(convert(0, 'C', 'F').value, 32);
  assertClose(convert(100, 'C', 'F').value, 212);
  assertClose(convert(-40, 'C', 'F').value, -40);
  assert.equal(convert(37, 'C', 'F').unit, 'F');
});

test('Fahrenheit to Celsius conversion uses the correct formula', () => {
  assertClose(convert(32, 'F', 'C').value, 0);
  assertClose(convert(212, 'F', 'C').value, 100);
  assertClose(convert(-40, 'F', 'C').value, -40);
  assert.equal(convert(98.6, 'F', 'C').unit, 'C');
});

test('Kelvin conversions use C + 273.15 relationship', () => {
  assertClose(convert(0, 'C', 'K').value, 273.15);
  assertClose(convert(273.15, 'K', 'C').value, 0);
  assertClose(convert(0, 'K', 'C').value, -273.15);
  assertClose(convert(32, 'F', 'K').value, 273.15);
  assertClose(convert(273.15, 'K', 'F').value, 32);
});

test('conversion does not round the result to an integer', () => {
  const result = convert(0, 'F', 'C').value;
  assertClose(result, -17.77777777777778);
  assert.notEqual(result, -18);
});

test('same-unit conversion preserves the value', () => {
  assertClose(convert(25, 'C', 'C').value, 25);
  assertClose(convert(-3.5, 'F', 'F').value, -3.5);
  assertClose(convert(100, 'K', 'K').value, 100);
  assert.equal(convert(25, 'C', 'C').unit, 'C');
  assert.equal(convert(100, 'K', 'K').unit, 'K');
});

test('negative Celsius and Fahrenheit above absolute zero are valid', () => {
  assertClose(convert(-10, 'C', 'F').value, 14);
  assertClose(convert(-10, 'F', 'C').value, -23.333333333333332);
});

test('validate returns normalized value/from/to for valid payload', () => {
  assert.deepEqual(validate({ value: 10, from: 'C', to: 'F' }), {
    value: 10,
    from: 'C',
    to: 'F'
  });
});

test('validate rejects missing value field', () => {
  assert.throws(() => validate({ from: 'C', to: 'F' }), /value/);
});

test('validate rejects missing from field', () => {
  assert.throws(() => validate({ value: 0, to: 'F' }), /from/);
});

test('validate rejects missing to field', () => {
  assert.throws(() => validate({ value: 0, from: 'C' }), /to/);
});

test('validate rejects nonnumeric values', () => {
  assert.throws(() => validate({ value: '10', from: 'C', to: 'F' }), /number/i);
  assert.throws(() => validate({ value: NaN, from: 'C', to: 'F' }), /number/i);
  assert.throws(() => validate({ value: Infinity, from: 'C', to: 'F' }), /number/i);
});

test('validate rejects boolean values', () => {
  assert.throws(() => validate({ value: true, from: 'C', to: 'F' }), /number/i);
  assert.throws(() => validate({ value: false, from: 'C', to: 'F' }), /number/i);
});

test('validate rejects unsupported units', () => {
  assert.throws(() => validate({ value: 0, from: 'X', to: 'F' }), /unit/i);
  assert.throws(() => validate({ value: 0, from: 'C', to: 'X' }), /unit/i);
  assert.throws(() => validate({ value: 0, from: 'x', to: 'F' }), /unit/i);
});

test('validate rejects below absolute zero in Celsius', () => {
  assert.throws(() => validate({ value: -273.16, from: 'C', to: 'C' }), /absolute zero/i);
});

test('validate rejects below absolute zero in Fahrenheit', () => {
  assert.throws(() => validate({ value: -459.68, from: 'F', to: 'K' }), /absolute zero/i);
});

test('validate rejects below absolute zero in Kelvin', () => {
  assert.throws(() => validate({ value: -0.01, from: 'K', to: 'C' }), /absolute zero/i);
});

test('validate allows exact absolute zero boundaries', () => {
  assert.deepEqual(validate({ value: -273.15, from: 'C', to: 'F' }), {
    value: -273.15,
    from: 'C',
    to: 'F'
  });
  assert.deepEqual(validate({ value: -459.67, from: 'F', to: 'C' }), {
    value: -459.67,
    from: 'F',
    to: 'C'
  });
  assert.deepEqual(validate({ value: 0, from: 'K', to: 'C' }), {
    value: 0,
    from: 'K',
    to: 'C'
  });
});

test('validate rejects below-zero values even for same-unit conversion', () => {
  assert.throws(() => validate({ value: -273.16, from: 'C', to: 'C' }), /absolute zero/i);
  assert.throws(() => validate({ value: -0.1, from: 'K', to: 'K' }), /absolute zero/i);
});

test('validate allows insignificant floating-point error at boundaries', () => {
  // Slightly below the boundary but within tolerance.
  assert.doesNotThrow(() =>
    validate({ value: -273.15 - EPSILON, from: 'C', to: 'F' })
  );
  assert.doesNotThrow(() =>
    validate({ value: -459.67 - EPSILON, from: 'F', to: 'C' })
  );
  assert.doesNotThrow(() => validate({ value: -EPSILON, from: 'K', to: 'C' }));
});

test('validate rejects values clearly beyond the tolerance', () => {
  assert.throws(
    () => validate({ value: -273.15 - 1e-6, from: 'C', to: 'F' }),
    /absolute zero/i
  );
});

test('convert also enforces validation through validate', () => {
  assert.throws(() => convert(-300, 'C', 'K'), /absolute zero/i);
  assert.throws(() => convert('hot', 'C', 'F'), /number/i);
});