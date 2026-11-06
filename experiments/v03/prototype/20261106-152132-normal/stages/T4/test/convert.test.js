import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convert, validate, UNITS, ABSOLUTE_ZERO } from '../source/convert.js';

// A tiny helper to assert that convert throws an Error with a nonempty message.
function assertThrows(fn, match) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error, 'expected an Error instance');
    assert.ok(typeof error.message === 'string' && error.message.length > 0, 'expected a nonempty message');
    if (match !== undefined) {
      assert.match(error.message, match);
    }
    return true;
  });
}

test('C to F conversion', () => {
  assert.equal(convert(0, 'C', 'F'), 32);
  assert.equal(convert(100, 'C', 'F'), 212);
  assert.equal(convert(-40, 'C', 'F'), -40);
});

test('F to C conversion', () => {
  assert.equal(convert(32, 'F', 'C'), 0);
  assert.equal(convert(212, 'F', 'C'), 100);
  assert.equal(convert(-40, 'F', 'C'), -40);
});

test('C to K conversion', () => {
  assert.equal(convert(0, 'C', 'K'), 273.15);
  assert.equal(convert(100, 'C', 'K'), 373.15);
  assert.equal(convert(-273.15, 'C', 'K'), 0);
});

test('K to C conversion', () => {
  assert.equal(convert(273.15, 'K', 'C'), 0);
  assert.equal(convert(373.15, 'K', 'C'), 100);
  assert.equal(convert(0, 'K', 'C'), -273.15);
});

test('F to K conversion', () => {
  assert.equal(convert(32, 'F', 'K'), 273.15);
  assert.equal(convert(212, 'F', 'K'), 373.15);
});

test('K to F conversion', () => {
  assert.equal(convert(273.15, 'K', 'F'), 32);
  assert.equal(convert(373.15, 'K', 'F'), 212);
});

test('same-unit conversion preserves the value', () => {
  for (const unit of UNITS) {
    assert.equal(convert(25, unit, unit), 25);
    assert.equal(convert(0, unit, unit), 0);
    assert.equal(convert(-10, unit, unit), -10);
  }
});

test('negative values are preserved for C and F', () => {
  // Negative Celsius and Fahrenheit values above absolute zero are valid.
  assert.equal(convert(-40, 'C', 'F'), -40);
  assert.equal(convert(-40, 'C', 'C'), -40);
  assert.equal(convert(-40, 'F', 'F'), -40);
});

test('booleans are rejected', () => {
  assertThrows(() => convert(true, 'C', 'F'), /number/);
  assertThrows(() => convert(false, 'C', 'F'), /number/);
});

test('non-numeric values are rejected', () => {
  assertThrows(() => convert('100', 'C', 'F'), /number/);
  assertThrows(() => convert(null, 'C', 'F'), /number/);
  assertThrows(() => convert(undefined, 'C', 'F'), /number/);
  assertThrows(() => convert(NaN, 'C', 'F'), /number/);
  assertThrows(() => convert(Infinity, 'C', 'F'), /number/);
});

test('missing value is rejected', () => {
  assertThrows(() => convert(undefined, 'C', 'F'), /number/);
});

test('unsupported units are rejected', () => {
  assertThrows(() => convert(100, 'C', 'X'), /destination unit/);
  assertThrows(() => convert(100, 'X', 'C'), /source unit/);
  assertThrows(() => convert(100, 'c', 'f'), /source unit/);
  assertThrows(() => convert(100, 'C', 'f'), /destination unit/);
  assertThrows(() => convert(100, 1, 'F'), /source unit/);
  assertThrows(() => convert(100, 'C', 2), /destination unit/);
});

test('absolute-zero boundaries are allowed (FR4)', () => {
  // The exact boundary values must be accepted.
  assert.equal(convert(ABSOLUTE_ZERO.C, 'C', 'C'), -273.15);
  assert.equal(convert(ABSOLUTE_ZERO.F, 'F', 'F'), -459.67);
  assert.equal(convert(ABSOLUTE_ZERO.K, 'K', 'K'), 0);

  // Insignificant floating-point error at the boundary must be accepted.
  assert.equal(convert(ABSOLUTE_ZERO.F, 'F', 'C'), -273.15);
  assert.equal(convert(ABSOLUTE_ZERO.C, 'C', 'K'), 0);
  assert.equal(convert(ABSOLUTE_ZERO.K, 'K', 'C'), -273.15);
});

test('values below absolute zero are rejected (FR4)', () => {
  assertThrows(() => convert(-273.16, 'C', 'C'), /absolute zero/);
  assertThrows(() => convert(-459.68, 'F', 'F'), /absolute zero/);
  assertThrows(() => convert(-0.000001, 'K', 'K'), /absolute zero/);
});

test('below-zero rejected even for same-unit conversion (FR4)', () => {
  assertThrows(() => convert(-273.16, 'C', 'C'), /absolute zero/);
  assertThrows(() => convert(-459.68, 'F', 'F'), /absolute zero/);
  assertThrows(() => convert(-1, 'K', 'K'), /absolute zero/);
});

test('validate returns null for valid input and a nonempty string otherwise', () => {
  assert.equal(validate(100, 'C', 'F'), null);
  assert.equal(typeof validate(-273.16, 'C', 'C'), 'string');
});

test('UNITS and ABSOLUTE_ZERO are exported constants', () => {
  assert.deepEqual(UNITS, ['C', 'F', 'K']);
  assert.equal(ABSOLUTE_ZERO.C, -273.15);
  assert.equal(ABSOLUTE_ZERO.F, -459.67);
  assert.equal(ABSOLUTE_ZERO.K, 0);
  assert.ok(Object.isFrozen(UNITS));
  assert.ok(Object.isFrozen(ABSOLUTE_ZERO));
});