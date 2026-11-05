/**
 * User Service – HTTP Routes
 *
 * Endpoints (mounted under /api/users by the gateway, also directly):
 *   GET  /api/users/me                     – current user profile (requires auth)
 *   GET  /api/users/oidec/callback         – OIDC redirect callback (token exchange helper)
 *   GET  /api/users/health                 – dependency health
 *
 * The user-service owns the mapping from OIDC `sub` to the internal
 * `users` row. It does NOT expose other users' data: only the caller's
 * own profile (authorized by `sub`), so cross-user enumeration is blocked.
 */

const { Router } = require('express');
const { requireAuth } = require('@spacefractions/shared/auth');
const { BadRequestError, NotFoundError } = require('@spacefractions/shared/errors');
const { query, queryOne, getPool } = require('@spacefractions/shared/db');
const { get, set } = require('@spacefractions/shared/cache');

const router = Router();

/**
 * Resolve (and lazily create) the internal user row for an OIDC payload.
 * Returns the canonitalized user record.
 */
async function resolveUser(claims) {
  const sub = claims && claims.sub;
  if (!sub) {
    throw new BadRequestError('Token missing subject (sub) claim');
  }

  const username =
    claims.preferred_username ||
    claims.email ||
    claims.name ||
    `user-${sub.slice(0, 8)}`;
  const email = claims.email || null;

  // Fast path: cached mapping sub -> user row.
  const cacheKey = `user:sub:${sub}`;
  const cached = await get(cacheKey);
  if (cached) {
    return cached;
  }

  // Insert-or-select the user row idempotently by unique `sub`.
  const existing = await queryOne('SELECT * FROM users WHERE sub = $1', [sub]);
  if (existing) {
    await set(cacheKey, existing, 300);
    return existing;
  }

  const result = await query(
    `INSERT INTO users (sub, username, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (sub) DO UPDATE SET
       username = EXCLUDED.username,
       email = COALESCE(EXCLUDED.email, users.email)
     RETURNING *`,
    [sub, username, email]
  );

  const row = result.rows[0];
  await set(cacheKey, row, 300);
  return row;
}

/**
 * GET /api/users/me
 * Return the authenticated user's profile. The profile is keyed off the
 * OIDC `sub` claim, never off a client-supplied id, enforcing ownership.
 */
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await resolveUser(req.user);

    // Public profile shape: never include internal sub beyond what the
    // client already knows about itself.
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      createdAt: user.created_at
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/users/oidc/callback
 * OIDC authorization-code callback. In the Compose reference topology the
 * Keycloak client uses the "standard flow" redirect to the browser UI, so
 * this route is primarily a compatibility/extension point: it accepts an
 * authorization code (or an id_token), validates the token via the shared
 * OIDC validator, and returns the profile that results after resolution.
 *
 * NOTE: token validation here leverages shared/auth.validateToken, which
 * enforces issuer/audience/expiration. No client secret ever leaves the
 * server; placeholders only in configuration.
 */
router.get('/oidc/callback', async (req, res, next) => {
  try {
    const token = req.query.id_token || req.query.access_token;
    if (!token) {
      throw new BadRequestError('Missing id_token or access_token');
    }

    const { validateToken } = require('@spacefractions/shared/auth');
    const claims = await validateToken(token);
    const user = await resolveUser(claims);

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      subject: claims.sub
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/users/:id
 * Look up a specific user by internal id. Restricted to the caller's own
 * id (from a validated token); any attempt to read another user's profile
 * returns 404 (indistinguishable from nonexistence), satisfying the
 * "other users' data -> 403/404" contract requirement.
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestError('Invalid user id');
    }

    // The caller may only address their own profile.
    const self = await resolveUser(req.user);
    if (self.id !== id) {
      throw new NotFoundError('User not found');
    }

    res.json({
      id: self.id,
      username: self.username,
      email: self.email,
      createdAt: self.created_at
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;