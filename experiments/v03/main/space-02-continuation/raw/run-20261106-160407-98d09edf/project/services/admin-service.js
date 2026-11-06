'use strict';

/**
 * Admin service: authorization gate + admin-facing question CRUD entrypoint.
 *
 * The operator acceptance contract (space-fractions.md 19-31) requires
 * authenticated administrator question CRUD:
 *
 *   POST   /api/admin/questions          -> 201 {id, prompt, options, correctAnswer}
 *   GET    /api/admin/questions          -> 200 {questions:[...correctAnswer...]}
 *   DELETE /api/admin/questions/:id      -> 200 or 204
 *
 * and mandates that a *normal* (non-admin) user receive HTTP 403 on admin
 * endpoints. The original design (Architecture_Documentation.md 157-161)
 * specifies OAuth2 for authentication *and* authorization, with the realm
 * `admin` role driving the authorization decision.
 *
 * Responsibilities:
 *   * Enforce the `admin` role BEFORE any question is read or written, so the
 *     correct answer key is never exposed to a non-admin caller. This is the
 *     single choke point for admin authorization.
 *   * Delegate question storage/projection to `services/question-service.js`,
 *     which owns the schema, validation, stable ordering, and the player-safe
 *     vs. admin-safe projections.
 *   * Map typed domain errors (`QuestionError`, `AuthError`) to HTTP statuses,
 *     and normal (verified but non-admin) callers to 403.
 *
 * This module is deliberately thin: it holds no SQL and no question-shape
 * knowledge beyond what the question service already exports. It depends on
 * `lib/auth.requireRole` and `lib/auth.AuthError` for the role gate.
 */

const { AuthError, requireRole } = require('../lib/auth');
const { QuestionError, createQuestionService } = require('./question-service');

/**
 * Error type for admin-domain failures. `status` maps to an HTTP status code so
 * the gateway can propagate typed errors uniformly. (Kept distinct from
 * QuestionError so route handlers can attach admin-specific context if needed;
 * in practice we forward the underlying question/auth statuses directly.)
 */
class AdminError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'AdminError';
    this.code = code || 'ADMIN_ERROR';
    this.status = status || 500;
  }
}

/**
 * Convert a low-level domain error into one carrying a concrete HTTP status.
 *
 * `QuestionError` already carries a status (400 for validation etc.); `AuthError`
 * carries 401/403; anything else becomes 500. This keeps the gateway entirely
 * status-agnostic about question/authorization internals.
 */
function toAdminError(err) {
  if (err instanceof AdminError) return err;
  if (err instanceof AuthError) {
    return new AdminError(err.message, 'AUTH_ERROR', err.status || 401);
  }
  if (err instanceof QuestionError) {
    return new AdminError(err.message, err.code || 'QUESTION_ERROR', err.status || 400);
  }
  return new AdminError(
    (err && err.message) || 'Internal admin error',
    'ADMIN_ERROR',
    500
  );
}

/**
 * Build the admin service over a `pg` pool.
 *
 * The returned methods expect a *verified* OIDC payload (already decoded and
 * validated by `lib/auth`) so no network/identity infrastructure is needed here,
 * keeping the module unit-testable with a fake payload.
 *
 * @param {object} pool pg pool (see lib/db.js)
 * @param {object} [deps]
 * @param {object} [deps.questionService] question service backend; defaults to
 *   the real `createQuestionService(pool)`.
 */
function createAdminService(pool, { questionService = null } = {}) {
  const questions = questionService || createQuestionService(pool);

  /**
   * Assert the caller holds the required role (default 'admin'). Throws an
   * AuthError with status 403 when a verified token lacks the role, which the
   * gateway maps to HTTP 403 (the contract for normal users hitting admin
   * endpoints).
   */
  function authorize(payload, role) {
    requireRole(payload, role);
    return true;
  }

  /**
   * Create a question. Caller must be an admin (enforced inside). Returns the
   * admin projection including correctAnswer -> 201 at the route layer.
   */
  async function createQuestion(payload, input) {
    try {
      authorize(payload);
      return await questions.createQuestion(input);
    } catch (err) {
      throw toAdminError(err);
    }
  }

  /**
   * List all questions in stable order, admin projection (with correctAnswer).
   * Caller must be an admin -> 200 {questions:[...]} at the route layer.
   */
  async function listQuestions(payload) {
    try {
      authorize(payload);
      return await questions.listQuestions();
    } catch (err) {
      throw toAdminError(err);
    }
  }

  /**
   * Delete a question by id. Caller must be an admin. Returns true when deleted,
   * false when no such question existed (route layer maps to 200/204 vs 404).
   */
  async function deleteQuestion(payload, id) {
    try {
      authorize(payload);
      return await questions.deleteQuestion(id);
    } catch (err) {
      throw toAdminError(err);
    }
  }

  return {
    createQuestion,
    listQuestions,
    deleteQuestion,
  };
}

module.exports = {
  AdminError,
  toAdminError,
  createAdminService,
};