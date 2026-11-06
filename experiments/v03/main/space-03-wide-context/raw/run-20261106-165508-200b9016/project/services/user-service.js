'use strict';

/**
 * User service entrypoint: identity and profile resolution for Space Fractions.
 *
 * The Architecture_View "UserComponent" owns user identity data, and the
 * acceptance contract (space-fractions.md 41-49) requires that a *verified*
 * OIDC `sub` string map to a numeric internal user id via an idempotent
 * PostgreSQL upsert, and that all profile names be non-empty.
 *
 * Responsibilities:
 *   * Resolve a verified OIDC payload to a `users` row (numeric id + display
 *     name) using the idempotent upsert in the persistence layer.
 *   * Return a player-safe public profile (never leaks `sub`-derived internal
 *     data beyond what a client normally needs).
 *   * Distinguish a missing identity from an authorization exclusions so the
 *     gateway can produce 401/403/404 responses accurately.
 *
 * Authorization (admin vs. normal user) is NOT decided here; that gate lives in
 * the route layer (services/admin-service.js) via `requireRole`. This module
 * only performs identity mapping and profile retrieval.
 */

const { withTransaction, DbError } = require('../lib/db');
const { AuthError, subjectOf } = require('../lib/auth');
const { displayNameOf } = require('../lib/user-map');

/**
 * Error type for user-domain failures carrying an intended HTTP status so route
 * handlers can map errors without inspecting lower-layer exception details.
 */
class UserError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'UserError';
    this.code = code || 'USER_ERROR';
    this.status = status || 400;
  }
}

/**
 * Convert a `users` row into the public profile shape returned to a client.
 * The internal `sub` is intentionally omitted by default (it is an opaque
 * backend identifier); callers that need it for admin/diagnostics pass a flag.
 */
function toPublicUser(row) {
  return {
    id: row.id,
    displayName: row.display_name,
  };
}

/**
 * Build the user service over a `pg` pool.
 *
 * The returned methods never mutate game state and never require live identity
 * infrastructure: the payload passed in has already been verified by the auth
 * layer, so unit tests may call these methods with a fake backend/payload.
 */
function createUserService(pool) {
  /**
   * Resolve a *verified* OIDC payload to a numeric internal user id, using the
   * idempotent subject upsert. This is the single choke point through which an
   * external subject becomes an internal user id; it lives in a PostgreSQL
   * transaction (one owned client, rollback on error) per the contract.
   *
   * `payload` is a decoded JWT payload (already verified by lib/auth).
   * Returns the numeric internal user id.
   *
   * @throws {AuthError} when the payload has no usable subject.
   */
  async function resolveUserId(payload) {
    const sub = subjectOf(payload);
    const displayName = displayNameOf(payload);
    return withTransaction(pool, (client) =>
      upsertUser(client, sub, displayName)
    );
  }

  /**
   * Resolve a verified payload to a full public profile, inserting the user on
   * first sight (idempotent). Returns { id, displayName }.
   */
  async function getOrCreateProfile(payload) {
    const sub = subjectOf(payload);
    const displayName = displayNameOf(payload);

    const row = await withTransaction(pool, async (client) => {
      const id = await upsertUser(client, sub, displayName);
      const result = await client.query(
        `SELECT id, display_name FROM users WHERE id = $1`,
        [id]
      );
      return result.rows[0];
    });

    return toPublicUser(row);
  }

  /**
   * Look up the public profile for an already-mapped numeric user id.
   * Returns `null` when no such user exists (the gateway maps this to 404).
   */
  async function getProfile(userId) {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new UserError('invalid user id', 'INVALID_USER_ID', 400);
    }
    const result = await pool.query(
      `SELECT id, display_name FROM users WHERE id = $1`,
      [userId]
    );
    return result.rows.length ? toPublicUser(result.rows[0]) : null;
  }

  /**
   * Return the numeric internal user id for a verified subject without creating
   * a record when it already exists. Primarily useful for ownership checks that
   * already hold a mapped id; falls back to the idempotent upsert.
   */
  async function ensureUser(payload) {
    const sub = subjectOf(payload);
    const existing = await pool.query(
      `SELECT id FROM users WHERE sub = $1`,
      [sub]
    );
    if (existing.rows.length) {
      return existing.rows[0].id;
    }
    return resolveUserId(payload);
  }

  return {
    resolveUserId,
    getOrCreateProfile,
    getProfile,
    ensureUser,
  };
}

module.exports = {
  UserError,
  toPublicUser,
  createUserService,
};