'use strict';

/**
 * Question service: admin CRUD, stable ordering, and player-safe projection.
 *
 * Responsibilities (Architecture_Documentation.md §D "QuestionComponent" and the
 * operator acceptance contract, space-fractions.md 19-31):
 *
 *   * Admin-owned question storage backed by the `questions` table (PostgreSQL).
 *   * Stable question ordering (deterministic ORDER BY id).
 *   * Never include `correctAnswer` in a player-facing response; the correct
 *     answer key is only ever returned on the authenticated admin endpoints.
 *   * Optional Elasticsearch-backed search with a bounded timeout. The search
 *     client is injected so the module remains unit-testable without live
 *     infrastructure and degrades gracefully (authoritative DB fallback) when
 *     the search backend is absent or unavailable.
 *
 * Authorization is NOT enforced here. The owning admin route (services/admin-
 * service.js) performs the `requireRole('admin')` gate before delegating to this
 * module, per the acceptance contract (normal users -> 403 at the route layer).
 */

const { withTransaction, DbError } = require('../lib/db');
const { parseFraction } = require('../lib/fraction');

/** Default bounded timeout for downstream search calls (milliseconds). */
const DEFAULT_SEARCH_TIMEOUT_MS = 500;

/**
 * Error type for question-domain failures. `status` maps to an HTTP status code
 * so route handlers can propagate typed errors without inspecting SQL codes.
 */
class QuestionError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'QuestionError';
    this.code = code || 'QUESTION_ERROR';
    this.status = status || 400;
  }
}

/**
 * Validate a question payload before it is written.
 *
 *   prompt       -> non-empty string
 *   options      -> array of strings (at least one option)
 *   correctAnswer -> parseable single reduced fraction (server-side validation)
 *
 * Throws QuestionError (status 400) on any violation.
 */
function validateQuestion({ prompt, options, correctAnswer }) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new QuestionError('prompt must be a non-empty string', 'INVALID_PROMPT', 400);
  }
  if (!Array.isArray(options) || options.length === 0) {
    throw new QuestionError('options must be a non-empty array', 'INVALID_OPTIONS', 400);
  }
  for (const opt of options) {
    if (typeof opt !== 'string') {
      throw new QuestionError('each option must be a string', 'INVALID_OPTIONS', 400);
    }
  }
  if (typeof correctAnswer !== 'string' || correctAnswer.trim() === '') {
    throw new QuestionError('correctAnswer must be a non-empty string', 'INVALID_ANSWER', 400);
  }
  // Enforce the exact-rational-arithmetic contract at the boundary.
  try {
    parseFraction(correctAnswer);
  } catch (fractionErr) {
    throw new QuestionError(
      `correctAnswer is not a valid reduced fraction: ${fractionErr.message}`,
      'INVALID_ANSWER',
      400
    );
  }
}

/**
 * Convert a `questions` table row into the admin-facing shape.
 * Includes correctAnswer (callers must be behind the admin authorization gate).
 */
function toAdminQuestion(row) {
  return {
    id: row.id,
    prompt: row.prompt,
    options: typeof row.options === 'string' ? JSON.parse(row.options) : row.options,
    correctAnswer: row.correct_answer,
  };
}

/**
 * Convert a `questions` table row into the player-facing shape.
 * NEVER includes correctAnswer.
 */
function toPublicQuestion(row) {
  return {
    id: row.id,
    prompt: row.prompt,
    options: typeof row.options === 'string' ? JSON.parse(row.options) : row.options,
  };
}

/**
 * Build the question service over a `pg` pool and an optional search backend.
 *
 * `searchClient` is an adapter implementing:
 *   search(query) -> Promise<Array<{id, prompt}>>  (already public-safe)
 * `searchTimeoutMs` bounds the downstream call; on timeout or backend failure we
 * fall back to a database LIKE query so search remains authoritative and correct
 * even when Elasticsearch is unavailable.
 *
 * The returned methods never surface `correct_answer` unless explicitly part of
 * the admin contract.
 */
function createQuestionService(pool, { searchClient = null, searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT_MS } = {}) {
  /**
   * Create a question. Returns the admin projection (including correctAnswer).
   */
  async function createQuestion(input) {
    validateQuestion(input);
    const optionsJson = JSON.stringify(input.options);
    const result = await pool.query(
      `INSERT INTO questions (prompt, options, correct_answer)
       VALUES ($1, $2, $3)
       RETURNING id, prompt, options, correct_answer`,
      [input.prompt.trim(), optionsJson, formatCorrectAnswer(input.correctAnswer)]
    );
    return toAdminQuestion(result.rows[0]);
  }

  /**
   * List all questions in stable (id) order. Returns the admin projection:
   * { questions: [{ id, prompt, options, correctAnswer }] }.
   */
  async function listQuestions() {
    const result = await pool.query(
      `SELECT id, prompt, options, correct_answer
         FROM questions
        ORDER BY id`
    );
    return { questions: result.rows.map(toAdminQuestion) };
  }

  /**
   * List questions in the public (player-facing) shape, stable id order, never
   * including correctAnswer.
   */
  async function listPublicQuestions() {
    const result = await pool.query(
      `SELECT id, prompt, options
         FROM questions
        ORDER BY id`
    );
    return result.rows.map(toPublicQuestion);
  }

  /**
   * Fetch a single public question (no correctAnswer). Returns null if missing.
   */
  async function getPublicQuestion(id) {
    const result = await pool.query(
      `SELECT id, prompt, options FROM questions WHERE id = $1`,
      [id]
    );
    return result.rows.length ? toPublicQuestion(result.rows[0]) : null;
  }

  /**
   * Delete a question by id. Returns true when a row was deleted, false when no
   * such question existed.
   */
  async function deleteQuestion(id) {
    const result = await pool.query(
      `DELETE FROM questions WHERE id = $1 RETURNING id`,
      [id]
    );
    return result.rows.length > 0;
  }

  /**
   * Search questions by a plain-text query.
   *
   * Prefers the injected Elasticsearch client with a bounded timeout; on any
   * failure (absence, timeout, error) it falls back to an authoritative DB
   * `ILIKE` search so search never returns stale/empty results silently. Results
   * are always the public projection (no correctAnswer).
   */
  async function searchQuestions(query) {
    if (typeof query !== 'string' || query.trim() === '') {
      return [];
    }
    const term = query.trim();

    if (searchClient && typeof searchClient.search === 'function') {
      const result = await withTimeout(
        Promise.resolve(searchClient.search(term)),
        searchTimeoutMs
      );
      if (result && Array.isArray(result.matched)) {
        return result.matched.map((q) => toPublicQuestion(q));
      }
    }

    // Authoritative DB fallback (bounded to id order for stable results).
    const dbResult = await pool.query(
      `SELECT id, prompt, options
         FROM questions
        WHERE prompt ILIKE $1
        ORDER BY id`,
      [`%${escapeLike(term)}%`]
    );
    return dbResult.rows.map(toPublicQuestion);
  }

  return {
    createQuestion,
    listQuestions,
    listPublicQuestions,
    getPublicQuestion,
    deleteQuestion,
    searchQuestions,
  };
}

/**
 * Normalize a correct answer to the canonical single reduced fraction string so
 * the stored value always satisfies the DB CHECK constraint and the same
 * validator used at runtime. Preserves original sign/whole-number forms but
 * reduces where possible (e.g. "2/4" -> "1/2").
 */
function formatCorrectAnswer(answer) {
  const f = parseFraction(answer);
  // Re-render via reduce to guarantee reduced gcd = 1 form ("n/d").
  return `${f.numerator}/${f.denominator}`;
}

/** Escape `%`/`_` so an ILIKE pattern matches the literal term only. */
function escapeLike(term) {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Bound a promise to a timeout, resolving the fallback (undefined) rather than
 * throwing so callers can degrade gracefully.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(undefined);
      }
    }, ms);
    promise
      .then((val) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(val);
        }
      })
      .catch(() => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(undefined);
        }
      });
  });
}

module.exports = {
  QuestionError,
  validateQuestion,
  toAdminQuestion,
  toPublicQuestion,
  createQuestionService,
  DEFAULT_SEARCH_TIMEOUT_MS,
};