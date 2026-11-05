/**
 * Unit tests for OIDC authentication utilities (auth.js).
 *
 * These tests exercise the full authentication path including RS256
 * signature verification against a locally-provisioned JWKS (no live
 * provider required). Tokens are signed with a real RSA key; the matching
 * public JWK is injected via configure({ jwks }).
 */
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jose = require('jose');
const {
  configure,
  validateToken,
  requireAdmin,
  decodeJWT,
  findKey
} = require('../src/auth');
const { UnauthorizedError, ForbiddenError } = require('../src/errors');

const ISSUER = 'http://keycloak:8080/realms/spacefractions';
const AUDIENCE = 'account';
const KID = 'k1';

let privateKey;
let publicJWKS;

before(async () => {
  const { publicKey, privateKey: priv } = await jose.generateKeyPair('RS256');
  privateKey = priv;
  const jwk = await jose.exportJWK(publicKey);
  publicJWKS = {
    keys: [{ ...jwk, alg: 'RS256', use: 'sig', kid: KID }]
  };
});

/** Sign a JWT with the test RSA key. */
async function makeJwt(payload, { alg = 'RS256', kid = KID } = {}) {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg, typ: 'JWT', kid })
    .sign(privateKey);
}

beforeEach(() => {
  configure({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'spacefractions-client',
    OIDC_AUDIENCE: AUDIENCE,
    jwks: publicJWKS
  });
});

test('decodeJWT parses header and payload', async () => {
  const token = await makeJwt({ sub: 'u1', iss: ISSUER, aud: AUDIENCE });
  const { header, payload } = decodeJWT(token);
  assert.equal(header.alg, 'RS256');
  assert.equal(header.kid, KID);
  assert.equal(payload.sub, 'u1');
});

test('decodeJWT rejects malformed tokens', () => {
  assert.throws(() => decodeJWT('not-a-jwt'), /Invalid JWT format/);
  assert.throws(() => decodeJWT('a.b'), /Invalid JWT format/);
});

test('validateToken accepts a valid structural token', async () => {
  const payload = {
    sub: 'user-1',
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  const token = await makeJwt(payload);
  const decoded = await validateToken(token);
  assert.equal(decoded.sub, 'user-1');
});

test('validateToken strips Bearer prefix', async () => {
  const payload = {
    sub: 'user-1',
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  const token = `Bearer ${await makeJwt(payload)}`;
  const decoded = await validateToken(token);
  assert.equal(decoded.sub, 'user-1');
});

test('validateToken rejects expired tokens', async () => {
  const payload = {
    sub: 'user-1',
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) - 10
  };
  await assert.rejects(
    async () => validateToken(await makeJwt(payload)),
    (err) => err instanceof UnauthorizedError
  );
});

test('validateToken rejects not-yet-valid tokens', async () => {
  const payload = {
    sub: 'user-1',
    iss: ISSUER,
    aud: AUDIENCE,
    nbf: Math.floor(Date.now() / 1000) + 3600
  };
  await assert.rejects(
    async () => validateToken(await makeJwt(payload)),
    (err) => err instanceof UnauthorizedError
  );
});

test('validateToken rejects wrong issuer', async () => {
  const payload = {
    sub: 'user-1',
    iss: 'http://evil.example.com',
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  await assert.rejects(
    async () => validateToken(await makeJwt(payload)),
    (err) => err instanceof UnauthorizedError
  );
});

test('validateToken rejects wrong audience', async () => {
  const payload = {
    sub: 'user-1',
    iss: ISSUER,
    aud: 'other-client',
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  await assert.rejects(
    async () => validateToken(await makeJwt(payload)),
    (err) => err instanceof UnauthorizedError
  );
});

test('validateToken rejects tokens signed by a different key', async () => {
  const { privateKey: otherKey } = await jose.generateKeyPair('RS256');
  const payload = {
    sub: 'user-1',
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  const token = await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: KID })
    .sign(otherKey);
  await assert.rejects(
    () => validateToken(token),
    (err) => err instanceof UnauthorizedError
  );
});

test('validateToken accepts array audience containing expected value', async () => {
  const payload = {
    sub: 'user-1',
    iss: ISSUER,
    aud: ['other-client', AUDIENCE],
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  const decoded = await validateToken(await makeJwt(payload));
  assert.equal(decoded.sub, 'user-1');
});

test('validateToken throws when OIDC not configured', async () => {
  const originalIssuer = process.env.OIDC_ISSUER;
  const originalAudience = process.env.OIDC_AUDIENCE;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_AUDIENCE;
  try {
    configure({});
    const token = await makeJwt({
      sub: 'u1',
      exp: Math.floor(Date.now() / 1000) + 3600
    });
    await assert.rejects(
      () => validateToken(token),
      (err) => err instanceof UnauthorizedError && /not configured/i.test(err.message)
    );
  } finally {
    if (originalIssuer !== undefined) process.env.OIDC_ISSUER = originalIssuer;
    if (originalAudience !== undefined) process.env.OIDC_AUDIENCE = originalAudience;
  }
});

test('requireAdmin allows users with admin role', () => {
  const req = { user: { realm_access: { roles: ['admin', 'user'] } } };
  let called = false;
  requireAdmin(req, {}, () => { called = true; });
  assert.equal(called, true);
});

test('requireAdmin rejects users without admin role', () => {
  const req = { user: { realm_access: { roles: ['user'] } } };
  let error = null;
  requireAdmin(req, {}, (err) => { error = err; });
  assert.ok(error instanceof ForbiddenError);
});

test('requireAdmin rejects missing realm_access', () => {
  const req = { user: { sub: 'u1' } };
  let error = null;
  requireAdmin(req, {}, (err) => { error = err; });
  assert.ok(error instanceof ForbiddenError);
});

test('requireAdmin rejects unauthenticated requests', () => {
  const req = {};
  let error = null;
  requireAdmin(req, {}, (err) => { error = err; });
  assert.ok(error instanceof UnauthorizedError);
});

test('findKey locates a key by kid', () => {
  const jwks = {
    keys: [
      { kid: 'a', kty: 'RSA' },
      { kid: 'b', kty: 'RSA' }
    ]
  };
  const key = findKey(jwks, 'b');
  assert.deepEqual(key, { kid: 'b', kty: 'RSA' });
  assert.equal(findKey(jwks, 'missing'), null);
  assert.equal(findKey(null, 'b'), null);
  assert.equal(findKey({}, 'b'), null);
});