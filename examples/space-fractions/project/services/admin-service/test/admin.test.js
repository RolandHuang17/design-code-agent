/**
 * Unit tests for the admin-service question validation and serialization.
 *
 * The admin routes module requires `@spacefractions/shared/*` (auth, errors,
 * db, metrics) and the question-service search helper (`@elastic/elasticsearch`).
 * All of these are lazy at require time (no DB/ES connection is established
 * merely by importing), so the pure helpers `validateQuestionPayload` and
 * `toAdminQuestion` can be exercised without live infrastructure.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { BadRequestError } = require('@spacefractions/shared/errors');
const { formatFraction } = require('@spacefractions/shared/fraction');
const { validateQuestionPayload, toAdminQuestion } = require('../src/routes');

/**
 * A minimal valid payload and the expected normalized correctAnswer.
 */
const VALID = {
  prompt: '  What is 1/2 of 1/2?  ',
  options: ['1/2', '1/4', '3/4', '1'],
  correctAnswer: '1/4'
};

test('validateQuestionPayload normalizes a valid payload', () => {
  const result = validateQuestionPayload(VALID);
  assert.equal(result.prompt, 'What is 1/2 of 1/2?');
  assert.deepEqual(result.options, ['1/2', '1/4', '3/4', '1']);
  assert.equal(result.correctAnswer, '1/4');
});

test('validateQuestionPayload normalizes equivalent correctAnswer to canonical form', () => {
  // "2/4" is listed as "1/4"? No — use an equivalent: list "2/8" is not present.
  // Instead, list "1/2" and supply correctAnswer "2/4" (equal rational).
  const result = validateQuestionPayload({
    prompt: 'p',
    options: ['1/2', '1/3'],
    correctAnswer: '2/4'
  });
  assert.equal(result.correctAnswer, formatFraction('2/4')); // "1/2"
});

test('validateQuestionPayload rejects a null body', () => {
  assert.throws(() => validateQuestionPayload(null), BadRequestError);
  assert.throws(() => validateQuestionPayload('string'), BadRequestError);
});

test('validateQuestionPayload rejects a missing or empty prompt', () => {
  assert.throws(
    () => validateQuestionPayload({ options: ['1/2', '1/4'], correctAnswer: '1/4' }),
    (err) => err instanceof BadRequestError && /prompt/.test(err.message)
  );
  assert.throws(
    () => validateQuestionPayload({ prompt: '   ', options: ['1/2', '1/4'], correctAnswer: '1/4' }),
    (err) => err instanceof BadRequestError && /prompt/.test(err.message)
  );
});

test('validateQuestionPayload rejects a non-string prompt', () => {
  assert.throws(
    () => validateQuestionPayload({ prompt: 42, options: ['1/2', '1/4'], correctAnswer: '1/4' }),
    BadRequestError
  );
});

test('validateQuestionPayload rejects options that are not an array', () => {
  assert.throws(
    () => validateQuestionPayload({ prompt: 'p', options: '1/2', correctAnswer: '1/2' }),
    BadRequestError
  );
});

test('validateQuestionPayload rejects too few options', () => {
  assert.throws(
    () => validateQuestionPayload({ prompt: 'p', options: ['1/2'], correctAnswer: '1/2' }),
    (err) => err instanceof BadRequestError && /between 2 and 10/.test(err.message)
  );
});

test('validateQuestionPayload rejects too many options', () => {
  const options = Array.from({ length: 11 }, (_, i) => `1/${i + 1}`);
  assert.throws(
    () => validateQuestionPayload({ prompt: 'p', options, correctAnswer: options[0] }),
    (err) => err instanceof BadRequestError && /between 2 and 10/.test(err.message)
  );
});

test('validateQuestionPayload rejects blank or non-string options', () => {
  assert.throws(
    () => validateQuestionPayload({ prompt: 'p', options: ['1/2', ''], correctAnswer: '1/2' }),
    BadRequestError
  );
  assert.throws(
    () => validateQuestionPayload({ prompt: 'p', options: ['1/2', 5], correctAnswer: '1/2' }),
    BadRequestError
  );
});

test('validateQuestionPayload rejects duplicate options', () => {
  assert.throws(
    () => validateQuestionPayload({ prompt: 'p', options: ['1/2', '1/2'], correctAnswer: '1/2' }),
    (err) => err instanceof BadRequestError && /duplicate/i.test(err.message)
  );
});

test('validateQuestionPayload rejects a malformed correctAnswer', () => {
  assert.throws(
    () => validateQuestionPayload({ prompt: 'p', options: ['1/2', '1/4'], correctAnswer: 'abc' }),
    (err) => err instanceof BadRequestError && /well-formed fraction/.test(err.message)
  );
  assert.throws(
    () => validateQuestionPayload({ prompt: 'p', options: ['1/2', '1/4'], correctAnswer: '1/0' }),
    (err) => err instanceof BadRequestError && /well-formed fraction/.test(err.message)
  );
  assert.throws(
    () => validateQuestionPayload({ prompt: 'p', options: ['1/2', '1/4'], correctAnswer: '' }),
    BadRequestError
  );
});

test('validateQuestionPayload rejects correctAnswer not present among options', () => {
  assert.throws(
    () => validateQuestionPayload({ prompt: 'p', options: ['1/2', '1/4'], correctAnswer: '3/4' }),
    (err) => err instanceof BadRequestError && /one of the provided options/.test(err.message)
  );
});

test('validateQuestionPayload accepts an equivalent correctAnswer listed as an option', () => {
  // "2/4" equals "1/2" which IS listed, so this should validate.
  const result = validateQuestionPayload({
    prompt: 'p',
    options: ['3/4', '1/2'],
    correctAnswer: '2/4'
  });
  assert.equal(result.correctAnswer, '1/2');
});

test('toAdminQuestion maps a DB row to an admin response shape', () => {
  const row = {
    id: 5,
    prompt: 'What is 1/4 + 1/4?',
    options: ['1/4', '1/2', '3/4', '1'],
    correct_answer: '1/2',
    created_by: 9,
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-02T00:00:00Z')
  };
  const result = toAdminQuestion(row);
  assert.deepEqual(result, {
    id: 5,
    prompt: 'What is 1/4 + 1/4?',
    options: ['1/4', '1/2', '3/4', '1'],
    correctAnswer: '1/2',
    createdBy: 9,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
});