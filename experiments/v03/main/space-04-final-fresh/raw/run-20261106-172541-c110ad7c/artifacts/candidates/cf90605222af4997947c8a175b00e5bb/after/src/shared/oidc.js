'use strict';

/**
 * Shared OIDC helpers for Space Fractions.
 *
 * Implements the OIDC contract from space-fractions.md lines 10-14 and 37-44:
 *   - Validate a Bearer OIDC access token: issuer, audience and JWKS-signature.
 *   - Map the verified `sub` claim to the numeric internal user id (done in the
 *     user-service; this module only produces the verified claims/roles).
 *   - Expose an admin-role check consumed by the admin-service.
 *
 * Environment contract (space-fractions.md line 40):
 *   - OIDC_ISSUER   public issuer origin (validated exactly against the `iss` claim).
 *   - OIDC_JWKS_URI internal certificates endpoint
 *                    (default http://keycloak:8080/realms/space-fractions/protocol/openid-connect/certs).
 *   - OIDC_AUDIENCE expected audience (default "account").
 *   - OIDC_ADMIN_ROLE role name conferring administrator privileges (default "admin").
 *
 * This module is dependency-free: JWT verification uses Node's built-in
 * `crypto` (RS256/RS384/RS512/ES256) and `fetch` for JWKS. It is therefore
 * unit-testable without a live identity provider by injecting a JWKS/verify
 * strategy via `createTokenVerifier` (see below).
 */

const crypto = require('crypto');

const DEFAULT_JWKS_URI =
  'http://keycloak:8080/realms/space-fractions/protocol/openid-connect/certs';

/** OIDC authentication error (missing/invalid credentials -> HTTP 401). */
class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
  }
}

/**
 * Extract the raw bearer token from an Authorization header.
 *   "Bearer <token>" -> "<token>"
 * Missing header or malformed scheme throws AuthError (401).
 *
 * @param {string|undefined} header
 * @returns {string}
 */
function bearerToken(header) {
  if (!header || typeof header !== 'string') {
    throw new AuthError('missing authorization header');
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) {
    throw new AuthError('malformed authorization header');
  }
  return match[1];
}

/**
 * Extract roles from a decoded JWT payload. Accepts the standard Keycloak
 * `realm_access.roles` claim plus an explicit `roles` array. Returns an array
 * (possibly empty).
 *
 * @param {object} payload
 * @returns {string[]}
 */
function extractRoles(payload) {
  if (payload && Array.isArray(payload.roles)) {
    return payload.roles.slice();
  }
  if (
    payload &&
    payload.realm_access &&
    Array.isArray(payload.realm_access.roles)
  ) {
    return payload.realm_access.roles.slice();
  }
  return [];
}

/** True when the payload carries the configured administrator role. */
function isAdmin(payload, adminRole) {
  const role = adminRole || process.env.OIDC_ADMIN_ROLE || 'admin';
  return extractRoles(payload).includes(role);
}

/** Base64url-decode a JWT segment. */
function b64urlDecode(segment) {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/** Decode a JWT into { header, payload, signature } without verifying. */
function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw new AuthError('malformed token');
  }
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch {
    throw new AuthError('malformed token');
  }
  return { header, payload, signature: parts[2] };
}

/**
 * Verify an RS/ES JWT signature against a JWK.
 *
 * Supports RS256/RS384/RS512 (RSA) and ES256 (EC P-256). Returns true when the
 * signature is valid. Throws AuthError on unsupported algorithms or bad JWK.
 */
function verifySignature(token, jwk) {
  const { header, signature } = decodeJwt(token);
  const alg = header.alg;
  const signingInput = token.split('.').slice(0, 2).join('.');

  const hashFor = (a) => {
    if (a === 'RS256' || a === 'ES256') return 'sha256';
    if (a === 'RS384' || a === 'ES384') return 'sha384';
    if (a === 'RS512' || a === 'ES512') return 'sha512';
    throw new AuthError(`unsupported algorithm: ${a}`);
  };

  const input = Buffer.from(signingInput, 'utf8');
  const sig = b64urlDecode(signature);

  if (alg.startsWith('RS')) {
    const key = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: jwk.n,
        e: jwk.e,
      },
      format: 'jwk',
    });
    return crypto.verify(hashFor(alg), input, key, sig);
  }

  if (alg.startsWith('ES')) {
    const key = crypto.createPublicKey({
      key: {
        kty: 'EC',
        crv: jwk.crv || 'P-256',
        x: jwk.x,
        y: jwk.y,
      },
      format: 'jwk',
    });
    // ES signatures are raw r||s; Node expects DER. Convert.
    const r = sig.subarray(0, sig.length / 2);
    const s = sig.subarray(sig.length / 2);
    const der = derEncodeEcdsa(r, s);
    return crypto.verify(hashFor(alg), input, key, der);
  }

  throw new AuthError(`unsupported algorithm: ${alg}`);
}

/** Encode an ECDSA raw r||s signature into a minimal DER structure. */
function derEncodeEcdsa(r, s) {
  const toDerInt = (buf) => {
    let b = buf;
    while (b.length > 0 && b[0] === 0) b = b.subarray(1);
    if (b.length > 0 && b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  };
  const rInt = toDerInt(r);
  const sInt = toDerInt(s);
  const body = Buffer.concat([rInt, sInt]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Create a token verifier.
 *
 * @param {object} options
 * @param {string} [options.issuer]   expected issuer (env OIDC_ISSUER)
 * @param {string} [options.audience] expected audience (env OIDC_AUDIENCE, default "account")
 * @param {string} [options.jwksUri]  JWKS endpoint (env OIDC_JWKS_URI)
 * @param {object} [options.jwks]     preloaded JWKS JSON (injected for tests/no network)
 * @param {function} [options.fetch]  fetch implementation (default globalThis.fetch)
 * @param {number} [options.clockToleranceSeconds]
 * @returns {{ verify: (token: string) => Promise<object> }}
 */
function createTokenVerifier(options = {}) {
  const issuer = options.issuer || process.env.OIDC_ISSUER;
  const audience = options.audience || process.env.OIDC_AUDIENCE || 'account';
  const jwksUri = options.jwksUri || process.env.OIDC_JWKS_URI || DEFAULT_JWKS_URI;
  const fetchImpl = options.fetch || globalThis.fetch;
  const tolerance =
    (options.clockToleranceSeconds || 0) * 1000;
  const adminRole = process.env.OIDC_ADMIN_ROLE || 'admin';

  let cachedJwks = options.jwks || null;

  async function getJwks() {
    if (cachedJwks) return cachedJwks;
    if (typeof fetchImpl !== 'function') {
      throw new AuthError('no JWKS source configured');
    }
    const res = await fetchImpl(jwksUri, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new AuthError(`jwks fetch failed: ${res.status}`);
    }
    cachedJwks = await res.json();
    return cachedJwks;
  }

  async function verify(token) {
    const { header, payload } = decodeJwt(token);

    // 1. Signature against a matching JWK (kid preferred).
    const jwks = await getJwks();
    const keys = (jwks && jwks.keys) || [];
    const candidates = keys.filter(
      (k) => k.kty === 'RSA' || (k.kty === 'EC' && k.crv === 'P-256'),
    );
    const key =
      candidates.find((k) => k.kid && k.kid === header.kid) ||
      candidates[0];
    if (!key) {
      throw new AuthError('no matching key');
    }
    let valid = false;
    try {
      valid = verifySignature(token, key);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      valid = false;
    }
    if (!valid) {
      throw new AuthError('invalid signature');
    }

    // 2. Issuer.
    if (issuer && payload.iss !== issuer) {
      throw new AuthError('invalid issuer');
    }

    // 3. Audience: accept string or array membership.
    const aud = payload.aud;
    const audOk = Array.isArray(aud)
      ? aud.includes(audience)
      : aud === audience;
    if (!audOk) {
      throw new AuthError('invalid audience');
    }

    // 4. Expiry with a small clock tolerance.
    const nowMs = Date.now();
    if (typeof payload.exp === 'number' && payload.exp * 1000 + tolerance < nowMs) {
      throw new AuthError('token expired');
    }
    if (typeof payload.nbf === 'number' && payload.nbf * 1000 - tolerance > nowMs) {
      throw new AuthError('token not yet valid');
    }

    return payload;
  }

  return { verify };
}

module.exports = {
  AuthError,
  bearerToken,
  decodeJwt,
  extractRoles,
  isAdmin,
  createTokenVerifier,
  verifySignature,
  derEncodeEcdsa,
  DEFAULT_JWKS_URI,
};