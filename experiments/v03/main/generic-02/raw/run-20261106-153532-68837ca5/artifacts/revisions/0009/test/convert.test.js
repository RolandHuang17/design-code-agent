import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED_UNITS,
  isSupportedUnit,
  toCelsius,
  fromCelsius,
  validateInput,
  convert,
} from '../src/convert.js';

const EPSILON = 1e-9;

function assertClose(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${message}: expected ~${expected}, got ${actual}`,
  );
}

test('SUPPORTED_UNITS contains exactly C, F, K', () => {
  assert.deepEqual(SUPPORTED_UNITS, ['C', 'F', 'K']);
});

test('same-unit conversion preserves the value unchanged', () => {
  const samples = [0, 100, -40, 451.25, -273.15];
  for (const unit of SUPPORTED_UNITS) {
    for (const value of samples) {
      if (value < 0 && unit === 'K') continue; // below absolute zero
      assert.strictEqual(convert(value, unit, unit), value);
    }
  }
});

test('Celsius to Fahrenheit and back', () => {
  assertClose(convert(0, 'C', 'F'), 32, '0C -> F');
  assertClose(convert(100, 'C', 'F'), 212, '100C -> F');
  assertClose(convert(212, 'F', 'C'), 100, '212F -> C');
});

test('Celsius to Kelvin and Kelvin to Celsius', () => {
  assertClose(convert(0, 'C', 'K'), 273.15, '0C -> K');
  assertClose(convert(100, 'C', 'K'), 373.15, '100C -> K');
  assertClose(convert(273.15, 'K', 'C'), 0, '273.15K -> C');
});

test('Fahrenheit to Kelvin and Kelvin to Fahrenheit', () => {
  assertClose(convert(32, 'F', 'K'), 273.15, '32F -> K');
  assertClose(convert(273.15, 'K', 'F'), 32, '273.15K -> F');
});

test('negative values above absolute zero convert correctly', () => {
  assertClose(convert(-40, 'C', 'F'), -40, '-40C -> F');
  assertClose(convert(-40, 'F', 'C'), -40, '-40F -> C');
  assertClose(convert(-100, 'F', 'C'), -73.33333333333333, '-100F -> C');
  assertClose(convert(-273.15, 'C', 'K'), 0, '-273.15C -> K');
});

test('absolute-zero boundary is accepted with float tolerance', () => {
  assert.strictEqual(convert(-273.15, 'C', 'C'), -273.15);
  assertClose(convert(-459.67, 'F', 'C'), -273.15, '-459.67F -> C');
  assert.strictEqual(convert(0, 'K', 'K'), 0);
  // Slightly inside tolerance should still validate (not below zero).
  const nearZero = -273.15 - EPSILON / 2;
  assert.strictEqual(validateInput(nearZero, 'C', 'C').ok, true);
});

test('rejects values below absolute zero (including same-unit)', () => {
  assert.throws(() => convert(-273.16, 'C', 'C'), /below absolute zero/i);
  assert.throws(() => convert(-459.68, 'F', 'C'), /below absolute zero/i);
  assert.throws(() => convert(-1, 'K', 'K'), /below absolute zero/i);
});

test('validateInput reports below zero for same-unit negative Kelvin', () => {
  const result = validateInput(-0.1, 'K', 'K');
  assert.deepEqual(result, { ok: false, error: 'Value is below absolute zero' });
});

test('validateInput rejects unsupported units and non-finite numbers', () => {
  assert.equal(validateInput(10, 'X', 'C').ok, false);
  assert.equal(validateInput(10, 'C', 'Y').ok, false);
  assert.equal(validateInput('10', 'C', 'F').ok, false);
  assert.equal(validateInput(NaN, 'C', 'F').ok, false);
  assert.equal(validateInput(Infinity, 'C', 'F').ok, false);
});

test('isSupportedUnit recognizes valid and rejects invalid units', () => {
  assert.equal(isSupportedUnit('C'), true);
  assert.equal(isSupportedUnit('F'), true);
  assert.equal(isSupportedUnit('K'), true);
  assert.equal(isSupportedUnit('x'), false);
  assert.equal(isSupportedUnit(undefined), false);
});

test('toCelsius and fromCelsius helpers convert between units', () => {
  assert.equal(toCelsius(32, 'F'), 0);
  assert.equal(toCelsius(273.15, 'K'), 0);
  assert.equal(fromCelsius(0, 'F'), 32);
  assert.equal(fromCelsius(0, 'K'), 273.15);
  assert.throws(() => toCelsius(0, 'Z'), /Unsupported unit/);
});