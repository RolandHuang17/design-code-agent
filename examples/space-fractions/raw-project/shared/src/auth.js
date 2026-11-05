/**
 * OAuth2/OIDC authentication middleware and utilities.
 *
 * Validates JWT access tokens against an OIDC provider using RS256
 * signature verification (jose), plus issuer/audience/expiry/nbf checks.
 *
 * Configuration (via configure()):
 *   - ORIGIN_ISSUER / OIDC_ISSUER      required issuer (e.g. Keycloak realm)
 *   - OIDC_CLIENT_ID                   optional
 *   - OIDC_AUDIENCE                    required audience (default "account")
 *   - OIDC_JWKS_URI                    explicit JWKS endpoint
 *   - jwks                             KeySet: a JWKS object `{ keys: [...] }`
 *                                      or a single JWK, used for *local*
 *                                      verification (tests / offline). Takes
 *                                      precedence over remote discovery.
 *
 * When only an issuer is configured without an explicit jwks/jwksUri, the
 * JWKS endpoint is discovered via the OIDC well-known document and used to
 * build a remote JWK set.
 */

const jose = require('jose');
const { UnauthorizedError, ForbiddenError } = require('./errors');

/** OIDC configuration state (null until configured). */
let oidcConfig = null;
/** Cached remote/local JWK set used for signature verification. */
let keySet = null;

/**
 * Fetch a remote JWKS document (also used by tests for key extraction).
 */
async function fetchJWKS(jwksUri) {
  let resp;
  try {
    resp = await fetch(jwksUri, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    throw new Error(`JWKS fetch failed: ${err.message}`);
  }
  if (!resp.ok) {
    throw new Error(`JWKS fetch failed: ${resp.status}`);
  }
  return resp.json();
}

/**
 * Find a key in a JWKS by kid.
 */
function findKey(jwks, kid) {
  if (!jwks || !Array.isArray(jwks.keys)) return null;
  return jwks.keys.find((k) => k.kid === kid) || null;
}

/**
 * Decode base64url to Uint8Array.
 */
function base64urlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '==='.slice(0, (4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Parse a JWT into { header, payload, signature } without verification.
 * Used for header inspection only.
 */
function decodeJWT(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
  return { header, payload, signature: parts[2] };
}

/**
 * Configure OIDC validation.
 *
 * @param {object} config - overrides; any value also falls back to the
 *   corresponding OIDC_* / ORIGIN_ISSUER environment variable.
 */
function configure(config = {}) {
  const env = process.env;
  const issuer =
    config.OIDC_ISSUER || config.ORIGIN_ISSUER || env.OIDC_ISSUER || env.ORIGIN_ISSUER || null;
  const clientId = config.OIDC_CLIENT_ID || env.OIDC_CLIENT_ID || null;
  const audience =
    config.OIDC_AUDIENCE ||
    env.OIDC_AUDIENCE ||
    config.AUDIENCE ||
    env.AUDIENCE ||
    'account';
  const jwksUri = config.OIDC_JWKS_URI || env.OIDC_JWKS_URI || null;
  const jwks = config.jwks || (env.OIDC_JWKS ? safeParseJson(env.OIDC_JWKS) : null);

  if (!issuer) {
    // Truly unconfigured: token validation must fail loudly rather than
    // silently accepting any structurally-valid token.
    oidcConfig = null;
    keySet = null;
    return;
  }

  oidcConfig = {
    issuer,
    clientId,
    audience,
    jwksUri,
    jwks: toJWKSObject(jwks)
  };

  // Build the verification key set eagerly when a local JWKS is supplied.
  if (oidcConfig.jwks) {
    keySet = jose.createLocalJWKSet(oidcConfig.jwks);
  } else {
    keySet = null; // resolved lazily via remote discovery
  }
}

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/** Normalize a JWK or a JWKS `{keys:[...]}` into a JWKS object. */
function toJWKSObject(value) {
  if (!value) return null;
  if (Array.isArray(value.keys)) return value;
  // A bare JWK (has kty) -> wrap as a single-key JWKS.
  if (value && value.kty) return { keys: [value] };
  return null;
}

/** Resolve the JWKS endpoint from the configured issuer (well-known). */
async function getJwksUri() {
  const issuer = oidcConfig && oidcConfig.issuer;
  if (!issuer) return null;
  if (oidcConfig.jwksUri) return oidcConfig.jwksUri;

  try {
    const resp = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000)
    });
    if (resp.ok) {
      const meta = await resp.json();
      oidcConfig.jwksUri = meta.jwks_uri;
      return oidcConfig.jwksUri;
    }
  } catch {
    /* fall through to Keycloak default */
  }
  oidcConfig.jwksUri = `${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`;
  return oidcConfig.jwksUri;
}

/** Return (and lazily build) the jose key set used for signature checks. */
async function getKeySet() {
  if (keySet) return keySet;
  const jwksUri = await getJwksUri();
  if (jwksUri) {
    keySet = jose.createRemoteJWKSet(new URL(jwksUri));
  }
  return keySet;
}

/**
 * Validate an OIDC Bearer token.
 *
 * Performs full RS256 signature verification against the configured JWKS and
 * enforces issuer / audience / expiration / not-before. Returns the decoded
 * payload on success and throws UnauthorizedError on any failure.
 */
async function validateToken(token) {
  if (!oidcConfig) {
    throw new UnauthorizedError('OIDC not configured');
  }

  const raw = token.startsWith('Bearer ') ? token.slice(7) : token;

  let header;
  try {
    header = decodeJWT(raw).header;
  } catch {
    throw new UnauthorizedError('Invalid token format');
  }

  // If a key set is available (local JWKS or discoverable remote), verify the
  // signature. Without it, fall back to claim checks only.
  const ks = await getKeySet();
  if (ks) {
    try {
      const { payload } = await jose.jwtVerify(raw, ks, {
        algorithms: ['RS256'],
        issuer: oidcConfig.issuer,
        audience: oidcConfig.audience
      });
      return payload;
    } catch (err) {
      // jose throws for both signature and claim failures; map to 401.
      throw new UnauthorizedError(`Token verification failed: ${err.message}`);
    }
  }

  // No key set available: perform structural + claim validation only.
  const { payload } = decodeJWT(raw);

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new UnauthorizedError('Token expired');
  }
  if (payload.nbf && payload.nbf > now) {
    throw new UnauthorizedError('Token not yet valid');
  }
  if (oidcConfig.issuer && payload.iss !== oidcConfig.issuer) {
    throw new UnauthorizedError(`Invalid issuer: expected ${oidcConfig.issuer}, got ${payload.iss}`);
  }
  const aud = payload.aud;
  const expectedAud = oidcConfig.audience;
  if (expectedAud) {
    const audList = Array.isArray(aud) ? aud : [aud];
    if (!audList.includes(expectedAud)) {
      throw new UnauthorizedError(`Invalid audience: expected ${expectedAud}`);
    }
  }
  void header;
  return payload;
}

/**
 * Express middleware that requires a valid Bearer token.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing or invalid Authorization header'));
  }

  validateToken(authHeader)
    .then((payload) => {
      req.user = payload;
      next();
    })
    .catch((err) => {
      next(err instanceof UnauthorizedError ? err : new UnauthorizedError(err.message));
    });
}

/**
 * Express middleware that requires the admin role. Use after requireAuth.
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return next(new UnauthorizedError('Authentication required'));
  }

  const roles = (req.user && req.user.realm_access && req.user.realm_access.roles) || [];
  if (!roles.includes('admin')) {
    return next(new ForbiddenError('Admin role required'));
  }

  next();
}

/**
 * Optional auth: sets req.user when a valid token is present, never fails.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  validateToken(authHeader)
    .then((payload) => {
      req.user = payload;
      next();
    })
    .catch(() => next());
}

module.exports = {
  configure,
  validateToken,
  requireAuth,
  requireAdmin,
  optionalAuth,
  decodeJWT,
  fetchJWKS,
  findKey
};