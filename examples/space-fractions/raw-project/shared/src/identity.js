/**
 * Canonical OIDC subject -> internal `users.id` resolution.
 *
 * The `users` table owns the mapping from the OIDC `sub` claim (a stable,
 * provider-issued string, e.g. a Keycloak UUID) to a numeric internal id used
 * as the foreign key for game ownership (`games.user_id`) and question
 * authorship (`questions.created_by`).
 *
 * Every service that needs an internal numeric user id MUST resolve it through
 * this function (rather than relying on the raw `sub`), so that game-service,
 * user-service and admin-service all agree on the same identity mapping.
 *
 * The resolution is an idempotent upsert on the unique `sub` column: if a row
 * already exists it is loaded (and its username/email refreshed), otherwise a
 * new row is created. Concurrent callers are safe thanks to `ON CONFLICT`.
 */

const { query, queryOne } = require('./db');
const { BadRequestError } = require('./errors');

/**
 * Resolve and return the numeric internal `users.id` for an authenticated
 * caller's OIDC claims, creating the row on first sight (idempotent).
 *
 * @param {object} claims - decoded (and already verified) OIDC token payload.
 * @returns {Promise<number>} the numeric `users.id`.
 * @throws {BadRequestError} when the claims lack a `sub`.
 */
async function resolveInternalUserId(claims) {
  const sub = claims && claims.sub;
  if (!sub) {
    throw new BadRequestError('Token missing subject (sub) claim');
  }

  const username =
    claims.preferred_username ||
    claims.email ||
    claims.name ||
    `user-${String(sub).slice(0, 8)}`;
  const email = claims.email || null;

  const existing = await queryOne('SELECT id FROM users WHERE sub = $1', [sub]);
  if (existing) {
    // Keep the human-readable fields fresh (best effort).
    await query(
      `UPDATE users SET username = $2, email = COALESCE($3, email) WHERE id = $1`,
      [existing.id, username, email]
    );
    return existing.id;
  }

  const result = await query(
    `INSERT INTO users (sub, username, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (sub) DO UPDATE SET
       username = EXCLUDED.username,
       email = COALESCE(EXCLUDED.email, users.email)
     RETURNING id`,
    [sub, username, email]
  );

  return result.rows[0].id;
}

module.exports = { resolveInternalUserId };