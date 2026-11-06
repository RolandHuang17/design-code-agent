'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  convert,
  ConversionError,
} = require('../lib/convert');

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

test('C to F uses C = (F - 32) * 5 / 9 inverse', () => {
  const result = convert(100, 'C', 'F');
  assert.strictEqual(result.unit, 'F');
  closeTo(result.value, 212);
});

test('F to C uses C = (F - 32) * 5 / 9', () => {
  const result = convert(32, 'F', 'C');
  assert.strictEqual(result.unit, 'C');
  closeTo(result.value, 0);
});

test('C to K uses K = C + 273.15', () => {
  const result = convert(0, 'C', 'K');
  assert.strictEqual(result.unit, 'K');
  closeTo(result.value, 273.15);
});

test('K to C uses C = K - 273.15', () => {
  const result = convert(273.15, 'K', 'C');
  assert.strictEqual(result.unit, 'C');
  closeTo(result.value, 0);
});

test('F to K converts through Celsius', () => {
  const result = convert(32, 'F', 'K');
  assert.strictEqual(result.unit, 'K');
  closeTo(result.value, 273.15);
});

test('K to F converts through Celsius', () => {
  const result = convert(273.15, 'K', 'F');
  assert.strictEqual(result.unit, 'F');
  closeTo(result.value, 32);
});

test('negative Celsius above absolute zero is valid', () => {
  const result = convert(-40, 'C', 'F');
  assert.strictEqual(result.unit, 'F');
  closeTo(result.value, -40);
});

test('negative Fahrenheit above absolute zero is valid', () => {
  const result = convert(-40, 'F', 'C');
  assert.strictEqual(result.unit, 'C');
  closeTo(result.value, -40);
});

test('same-unit conversion preserves the value', () => {
  const cases = [
    [100, 'C'],
    [32, 'F'],
    [300, 'K'],
  ];
  for (const [value, unit] of cases) {
    const result = convert(value, unit, unit);
    assert.strictEqual(result.unit, unit);
    assert.strictEqual(result.value, value);
  }
});

test('does not round the API value to an integer', () => {
  const result = convert(0.5, 'C', 'F');
  assert.strictEqual(result.unit, 'F');
  closeTo(result.value, 32.9);
});

test('absolute zero boundaries are accepted (with epsilon tolerance)', () => {
  const atZero = [
    [-273.15, 'C', 'C'],
    [-459.67, 'F', 'F'],
    [0, 'K', 'K'],
  ];
  for (const [value, from, to] of atZero) {
    const result = convert(value, from, to);
    assert.strictEqual(result.value, value);
  }
});

test('insignificant floating-point error at boundaries is tolerated', () => {
  const result = convert(-273.15 - 1e-12, 'C', 'K');
  assert.strictEqual(result.unit, 'K');
  closeTo(result.value, 0, 1e-9);
});

test('missing value is rejected', () => {
  assert.throws(() => convert(undefined, 'C', 'F'), ConversionError);
  assert.throws(() => convert(null, 'C', 'F'), ConversionError);
});

test('nonnumeric values are rejected', () => {
  for (const value of ['100', NaN, Infinity, -Infinity, {}, [], undefined]) {
    assert.throws(() => convert(value, 'C', 'F'), ConversionError);
  }
});

test('booleans are rejected', () => {
  assert.throws(() => convert(true, 'C', 'F'), ConversionError);
  assert.throws(() => convert(false, 'C', 'F'), ConversionError);
});

test('unsupported units are rejected', () => {
  assert.throws(() => convert(0, 'X', 'C'), ConversionError);
  assert.throws(() => convert(0, 'C', 'X'), ConversionError);
  assert.throws(() => convert(0, 'c', 'C'), ConversionError);
  assert.throws(() => convert(0, 'C', 1), ConversionError);
});

test('temperatures below absolute zero are rejected', () => {
  assert.throws(() => convert(-273.16, 'C', 'F'), ConversionError);
  assert.throws(() => convert(-459.68, 'F', 'C'), ConversionError);
  assert.throws(() => convert(-0.01, 'K', 'C'), ConversionError);
});

test('below-zero value is rejected even for same-unit conversion', () => {
  assert.throws(() => convert(-273.16, 'C', 'C'), ConversionError);
  assert.throws(() => convert(-459.68, 'F', 'F'), ConversionError);
  assert.throws(() => convert(-1, 'K', 'K'), ConversionError);
});

test('ConversionError carries a non-empty message', () => {
  try {
    convert(-500, 'C', 'F');
    assert.fail('expected ConversionError');
  } catch (err) {
    assert.ok(err instanceof ConversionError);
    assert.strictEqual(typeof err.message, 'string');
    assert.ok(err.message.length > 0);
  }
});