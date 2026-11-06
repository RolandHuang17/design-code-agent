'use strict';

/**
 * User mapping helper: verified OIDC subject -> numeric internal user id.
 *
 * The acceptance contract (space-fractions.md 41-49) requires that PostgreSQL own
 * all game state and that a *verified* `sub` string map to a numeric internal
 * user id. This module isolates that mapping so the auth module stays focused on
 * credential verification while persistence stays focused on SQL.
 *
 * Responsibilities:
 *   * `displayNameOf(payload)` — derive a stable, non-empty display name from
 *     preferred_username / name / email, falling back to the subject. This keeps
 *     profile names non-empty even for tokens that omit display claims.
 *   * `mapSubjectToUser(db, sub, displayName)` — perform the idempotent upsert via
 *     a client-shaped or pool-shaped backend and return the numeric user id.
 *
 * The heavy lifting is delegated to `lib/db.upsertUser(client, sub, displayName)`
 * and the subject extraction to `lib/auth.subjectOf`, so unit tests can inject a
 * fake `db` backend and a fake payload without any network or database access.
 */

const { subjectOf } = require('./auth');
const { upsertUser } = require('./db');

/**
 * Derive a human-readable display name from a decoded token.
 *
 * Order of precedence: preferred_username, name, email, then the raw subject.
 * Guarantees a non-empty string so the `users` table never stores an empty
 * profile name (contract requirement that all profile names be non-empty).
 *
 * @param {object} payload decoded JWT payload
 * @returns {string} non-empty display name
 */
function displayNameOf(payload) {
  const sub = payload && typeof payload.sub === 'string' ? payload.sub : '';
  const candidate =
    (payload && payload.preferred_username) ||
    (payload && payload.name) ||
    (payload && payload.email) ||
    sub ||
    'unknown';
  const trimmed = String(candidate).trim();
  return trimmed === '' ? (sub || 'unknown') : trimmed;
}

/**
 * Map a verified subject string to a numeric internal user id.
 *
 * `db` may be:
 *   * a client-shaped object exposing `upsertUser` (run the upsert directly);
 *   * a pool-shaped object exposing `withTransaction` (run the upsert in a
 *     single owned transaction with rollback-on-error).
 *
 * @param {object} db client/pool-shaped backend
 * @param {string} sub verified OIDC subject
 * @param {string} displayName non-empty display name
 * @returns {Promise<number>} numeric internal user id
 */
async function mapSubjectToUser(db, sub, displayName) {
  if (typeof db === 'object' && db !== null && typeof db.upsertUser === 'function') {
    return db.upsertUser(db.client || db, sub, displayName);
  }

  if (typeof db === 'object' && db !== null && typeof db.withTransaction === 'function') {
    return db.withTransaction(db, (client) => upsertUser(client, sub, displayName));
  }

  if (typeof db === 'object' && db !== null && typeof db.connect === 'function') {
    const { withTransaction } = require('./db');
    return withTransaction(db, (client) => upsertUser(client, sub, displayName));
  }

  throw new Error('No idempotent user-upsert backend available');
}

/**
 * Convenience wrapper: derive display name + subject from a decoded payload and
 * resolve to a numeric user id in one call.
 *
 * @param {object} db client/pool-shaped backend
 * @param {object} payload decoded JWT payload
 * @returns {Promise<number>} numeric internal user id
 */
async function resolveUserFromPayload(db, payload) {
  const sub = subjectOf(payload);
  return mapSubjectToUser(db, sub, displayNameOf(payload));
}

module.exports = {
  displayNameOf,
  mapSubjectToUser,
  resolveUserFromPayload,
};