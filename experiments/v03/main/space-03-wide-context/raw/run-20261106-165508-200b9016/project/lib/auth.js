'use strict';

/**
 * Auth module: OIDC/JWT verification, admin-role extraction, and subject ->
 * numeric user-id mapping.
 *
 * Contract (space-fractions.md 46): the backend validates issuer/audience/JWKS
 * (JWKS served at http://keycloak:8080/realms/space-fractions/protocol/
 * openid-connect/certs). Admin role is read from `realm_access.roles`. A
 * missing or invalid token yields HTTP 401.
 *
 * The design (Architecture_Documentation.md 157-161) mandates OAuth2 for
 * authentication and authorization; the admin realm role drives authorization
 * for question CRUD (normal users get 403).
 *
 * `jose` is used as the JWT/JWKS verifier. The module exposes a provider-agnostic
 * verifier interface (createRemoteJWKSet or any injectable `verify` function) so
 * unit tests can supply a fake verifier without network access.
 */

const { createRemoteJWKSet, jwtVerify } = require('jose');

const { upsertUser } = require('./db');

/**
 * Error type for authentication/authorization failures. `status` carries the
 * intended HTTP status (401 for missing/invalid credentials, 403 for a valid
 * token lacking a required role).
 */
class AuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AuthError';
    this.status = status || 401;
  }
}

/**
 * Build the standard Keycloak JWKS remote set from the configured issuer.
 *
 * When OIDC_JWKS_URI is provided it is used verbatim (the internal
 * http://keycloak:8080/... URL per the contract). Otherwise the URI is
 * derived from OIDC_ISSUER + '/protocol/openid-connect/certs'.
 *
 * Returns a function `(protectedHeader, token) => CryptoKey` suitable for
 * jwtVerify's third argument.
 */
function createDefaultVerifier(env) {
  const envRef = env || process.env;
  const jwksUri =
    envRef.OIDC_JWKS_URI ||
    `${(envRef.OIDC_ISSUER || '').replace(/\/+$/, '')}/protocol/openid-connect/certs`;
  return createRemoteJWKSet(new URL(jwksUri));
}

/**
 * Verify a Bearer token and return its decoded payload.
 *
 * `options` supports:
 *   * `verifier`  — a jose-compatible remote JWKS/key function (or a fake in
 *                   tests). Defaults to createDefaultVerifier(env).
 *   * `env`       — environment object (defaults to process.env).
 *
 * Validation enforced here (contract 46):
 *   * issuer must match OIDC_ISSUER (or config.issuer).
 *   * audience must match OIDC_AUDIENCE (or config.audience).
 *   * a missing `token` throws AuthError 401.
 *   * any verification failure throws AuthError 401.
 */
async function verifyToken(token, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const config = opts.config || {};

  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new AuthError('Missing bearer token', 401);
  }

  const issuer = config.issuer || env.OIDC_ISSUER;
  const audience = config.audience || env.OIDC_AUDIENCE;

  try {
    // `opts.verify` (when provided) replaces the entire jwtVerify call so unit
    // tests can inject a fake that returns a decoded payload without real
    // crypto or a live JWKS. Otherwise build the jose key function from a
    // provided `verifier` or the default remote JWKS set.
    let payload;
    if (opts.verify) {
      const tokenToVerify = token.trim();
      if (tokenToVerify.includes('.') && tokenToVerify.split('.').length !== 3) {
        throw new Error('Invalid Compact JWS');
      }
      const result = await opts.verify(tokenToVerify, { issuer, audience });
      payload = result && result.payload ? result.payload : result;
    } else {
      const verifyOptions = {
        issuer,
        algorithms: ['RS256'],
      };
      if (audience) verifyOptions.audience = audience;
      const verifier = opts.verifier || createDefaultVerifier(env);
      const verified = await jwtVerify(token.trim(), verifier, verifyOptions);
      payload = verified.payload;
    }
    return payload;
  } catch (err) {
    throw new AuthError(`Invalid bearer token: ${err.message}`, 401);
  }
}

/**
 * Extract the admin flag from a decoded token. Admin is true iff
 * `realm_access.roles` includes 'admin' (supplement assumption A-5).
 */
function isAdmin(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const roles = payload.realm_access && payload.realm_access.roles;
  return Array.isArray(roles) && roles.includes('admin');
}

/**
 * Ensure the caller has a role (default 'admin'), else 403.
 */
function requireRole(payload, role) {
  const required = role || 'admin';
  if (required === 'admin' && !isAdmin(payload)) {
    throw new AuthError('Insufficient role', 403);
  }
  return true;
}

/**
 * Extract the stable OIDC subject (sub) from a decoded token. Missing sub
 * indicates an unusable token.
 */
function subjectOf(payload) {
  if (!payload || typeof payload.sub !== 'string' || payload.sub === '') {
    throw new AuthError('Token has no subject', 401);
  }
  return payload.sub;
}

/**
 * Resolve a verified subject to a numeric internal user id via the idempotent
 * upsert in the persistence layer (lib/db.upsertUser). `db` is required and
 * must expose upsertUser(client, sub, displayName). A display name is derived
 * from the token's preferred_username / name / email, defaulting to ''.
 *
 * For transactions that already own a client, pass it as `db.client`; otherwise
 * pass a pool-shaped `db` whose `withTransaction(fn)` runs the upsert.
 */
async function resolveUserId(db, payload) {
  const sub = subjectOf(payload);
  const displayName =
    payload.preferred_username || payload.name || payload.email || '';

  if (typeof db === 'object' && db !== null && typeof db.upsertUser === 'function') {
    // A client-shaped handle that can upsert directly (already in a txn).
    return db.upsertUser(db.client || db, sub, displayName);
  }

  if (typeof db === 'object' && db !== null && typeof db.withTransaction === 'function') {
    return db.withTransaction(db, (client) =>
      upsertUser(client, sub, displayName)
    );
  }

  // A raw pool (pg.Pool or a fake adapter) only exposes connect(); run the
  // upsert inside a single owned transaction via lib/db.withTransaction.
  if (typeof db === 'object' && db !== null && typeof db.connect === 'function') {
    const { withTransaction } = require('./db');
    return withTransaction(db, (client) => upsertUser(client, sub, displayName));
  }

  throw new AuthError('No user mapping backend available', 500);
}

/**
 * Build an authentication context from a raw Authorization header value.
 *
 * Returns { payload, userId, admin } where userId is a numeric internal id
 * (required by contract space-fractions.md 41-49). Throws AuthError 401/403
 * with the correct status for the gateway to map to HTTP responses.
 *
 * `db` may be a pool (uses withTransaction) or a pre-acquired client.
 */
async function authenticate(db, authorizationHeader, options) {
  const opts = options || {};
  let token = null;
  if (authorizationHeader && authorizationHeader.startsWith('Bearer ')) {
    token = authorizationHeader.slice('Bearer '.length).trim();
  } else if (authorizationHeader) {
    token = authorizationHeader.trim();
  }

  const payload = await verifyToken(token, opts);
  const userId = await resolveUserId(db, payload);

  return {
    payload,
    userId,
    admin: isAdmin(payload),
  };
}

module.exports = {
  AuthError,
  verifyToken,
  isAdmin,
  requireRole,
  subjectOf,
  resolveUserId,
  authenticate,
  createDefaultVerifier,
};