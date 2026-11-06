'use strict';

/**
 * Unit tests for the auth module (lib/auth.js) and the user mapping helper
 * (lib/user-map.js). These tests use injected fake verifiers and fake db
 * backends only: no network, no live Keycloak, no PostgreSQL.
 *
 * Covered (space-fractions.md 39): authorization (401 missing/invalid token,
 * 403 missing admin role), admin-role extraction, subject -> numeric user id
 * mapping, and error behavior. This complements test/game-service.test.js
 * which covers scoring/pause/resume/dedup against in-memory adapters.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  AuthError,
  verifyToken,
  isAdmin,
  requireRole,
  subjectOf,
  resolveUserId,
  authenticate,
} = require('../lib/auth');
const {
  displayNameOf,
  mapSubjectToUser,
} = require('../lib/user-map');

/**
 * Build a fake jose verifier compatible with `verifyToken`. `jwtVerify` calls
 * `verifier(protectedHeader, token)` to fetch a CryptoKey, then verifies
 * signature+claims. A fake simply returns a sentinel key; because only the
 * fake is responsible for the verification result, we also need `verifyToken`
 * to trust it. The fake verifier below delegates to a supplied function so
 * tests can control success/failure.
 */
function fakeVerifier(payload) {
  return async function verifier(_protectedHeader, _token) {
    return payload; // sentinel: returning payload rather than a key is fine
    // because the real jwtVerify is never exercised for these tests; the
    // contract under test is the claim validation in the non-fake path only.
  };
}

/**
 * `verifyToken` invokes `jwtVerify(token, verifier, options)`. To unit-test the
 * issuer/audience/missing-token paths WITHOUT real crypto, tests inject
 * `options.verify`, a function that is called instead of jose's jwtVerify.
 * In that injected mode, `verifyToken` assigns (opts.verify) to `verifier` but
 * then still calls the real `jwtVerify`. To keep these tests pure we instead
 * assert on `verifyToken` via the injectable `verify` shim at the point where
 * `jwtVerify` is called. See `verifyToken` source: it uses
 * `opts.verify ? opts.verify : createDefaultVerifier`, and then
 * `jwtVerify(token, verifier, verifyOptions)`.
 *
 * Because jose's jwtVerify needs a real CryptoKey, the clean injection point is
 * `opts.verify` returning a jose-compatible key function. For pure tests we
 * therefore test the wrapper paths (missing token, subject extraction, role
 * checks) directly and validate claims logic via the `config` object rather
 * than a live signature. Rationale documented in architecture-decisions.md:
 * unit tests must not require live infra.
 */

// ---------------------------------------------------------------------------
// subjectOf
// ---------------------------------------------------------------------------

test('subjectOf returns the sub claim', () => {
  assert.strictEqual(subjectOf({ sub: 'abc-123' }), 'abc-123');
});

test('subjectOf throws 401 when sub is missing', () => {
  assert.throws(() => subjectOf({}), (err) => {
    assert.ok(err instanceof AuthError);
    assert.strictEqual(err.status, 401);
    return true;
  });
});

test('subjectOf throws 401 when sub is empty', () => {
  assert.throws(() => subjectOf({ sub: '' }), (err) => {
    assert.ok(err instanceof AuthError);
    assert.strictEqual(err.status, 401);
    return true;
  });
});

// ---------------------------------------------------------------------------
// isAdmin / requireRole
// ---------------------------------------------------------------------------

test('isAdmin is true when realm_access.roles contains admin', () => {
  assert.strictEqual(
    isAdmin({ realm_access: { roles: ['admin', 'user'] } }),
    true
  );
});

test('isAdmin is false when role absent', () => {
  assert.strictEqual(
    isAdmin({ realm_access: { roles: ['user'] } }),
    false
  );
});

test('isAdmin is false for malformed/missing payload', () => {
  assert.strictEqual(isAdmin(null), false);
  assert.strictEqual(isAdmin({}), false);
});

test('requireRole allows admin', () => {
  assert.strictEqual(
    requireRole({ realm_access: { roles: ['admin'] } }, 'admin'),
    true
  );
});

test('requireRole throws 403 for non-admin', () => {
  assert.throws(
    () => requireRole({ realm_access: { roles: ['user'] } }, 'admin'),
    (err) => {
      assert.ok(err instanceof AuthError);
      assert.strictEqual(err.status, 403);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// verifyToken: missing / malformed token (401)
// ---------------------------------------------------------------------------

test('verifyToken rejects a missing token with 401', async () => {
  await assert.rejects(
    () => verifyToken(null, { env: {} }),
    (err) => err instanceof AuthError && err.status === 401
  );
});

test('verifyToken rejects an empty/whitespace token with 401', async () => {
  await assert.rejects(
    () => verifyToken('   ', { env: {} }),
    (err) => err instanceof AuthError && err.status === 401
  );
});

test('verifyToken surfaces verification failure as 401 AuthError', async () => {
  // Inject a verifier that throws, simulating an invalid signature.
  const failing = async () => {
    throw new Error('signature verification failed');
  };
  await assert.rejects(
    () =>
      verifyToken('not-a-real-token', {
        env: { OIDC_ISSUER: 'http://keycloak:8080/realms/test' },
        verify: failing,
      }),
    (err) => err instanceof AuthError && err.status === 401
  );
});

// ---------------------------------------------------------------------------
// resolveUserId: subject -> numeric user id via injected backend
// ---------------------------------------------------------------------------

test('resolveUserId upserts via client-shaped db and returns numeric id', async () => {
  const calls = [];
  const client = {
    upsertUser: async (c, sub, displayName) => {
      calls.push({ sub, displayName });
      return 42;
    },
  };
  const id = await resolveUserId(client, { sub: 'sub-1', name: 'Student' });
  assert.strictEqual(id, 42);
  assert.deepStrictEqual(calls, [{ sub: 'sub-1', displayName: 'Student' }]);
});

test('resolveUserId upserts via pool-shaped db and returns numeric id', async () => {
  const pool = {
    withTransaction: async (p, fn) => fn({ query: async () => ({ rows: [{ id: 7 }] }) }),
  };
  const id = await resolveUserId(pool, { sub: 'sub-2' });
  assert.strictEqual(id, 7);
});

test('resolveUserId rejects payload missing sub with 401', async () => {
  const client = { upsertUser: async () => 1 };
  await assert.rejects(
    () => resolveUserId(client, {}),
    (err) => err instanceof AuthError && err.status === 401
  );
});

test('resolveUserId throws 500 when no backend is available', async () => {
  await assert.rejects(
    () => resolveUserId({}, { sub: 'sub-3' }),
    (err) => err instanceof AuthError && err.status === 500
  );
});

// ---------------------------------------------------------------------------
// displayNameOf / mapSubjectToUser
// ---------------------------------------------------------------------------

test('displayNameOf prefers preferred_username and falls back to sub', () => {
  assert.strictEqual(displayNameOf({ sub: 's', preferred_username: 'student' }), 'student');
  assert.strictEqual(displayNameOf({ sub: 's', name: 'Name' }), 'Name');
  assert.strictEqual(displayNameOf({ sub: 's' }), 's');
  assert.strictEqual(displayNameOf({}), 'unknown');
});

test('mapSubjectToUser delegates to upsertUser on client-shaped backend', async () => {
  const client = { upsertUser: async (_c, sub, name) => sanitize(sub, name) };
  function sanitize(sub, name) {
    return { sub, name };
  }
  const result = await mapSubjectToUser(client, 'sub-x', 'Admin');
  assert.deepStrictEqual(result, { sub: 'sub-x', name: 'Admin' });
});

test('mapSubjectToUser throws when no backend is available', async () => {
  await assert.rejects(
    () => mapSubjectToUser({}, 'sub-x', 'Name'),
    /No idempotent user-upsert backend available/
  );
});

// ---------------------------------------------------------------------------
// authenticate: full context assembly with injected verifier
// ---------------------------------------------------------------------------

test('authenticate returns payload/userId/admin for a valid admin token', async () => {
  const payload = {
    sub: 'admin-sub',
    preferred_username: 'admin',
    realm_access: { roles: ['admin'] },
  };
  const pool = {
    withTransaction: async (_p, fn) => fn({ query: async () => ({ rows: [{ id: 9 }] }) }),
  };
  const result = await authenticate(pool, 'Bearer my-token', {
    env: { OIDC_ISSUER: 'issuer' },
    verify: async () => payload,
  });
  assert.strictEqual(result.userId, 9);
  assert.strictEqual(result.admin, true);
  assert.strictEqual(result.payload.sub, 'admin-sub');
});

test('authenticate marks non-admin token as admin=false', async () => {
  const payload = {
    sub: 'student-sub',
    preferred_username: 'student',
    realm_access: { roles: ['user'] },
  };
  const client = { upsertUser: async () => 5 };
  const result = await authenticate(client, 'Bearer token', {
    env: {},
    verify: async () => payload,
  });
  assert.strictEqual(result.userId, 5);
  assert.strictEqual(result.admin, false);
});

test('authenticate throws 401 when authorization header lacks a token', async () => {
  const client = { upsertUser: async () => 5 };
  await assert.rejects(
    () => authenticate(client, 'Basic abc', { env: {} }),
    (err) => err instanceof AuthError && err.status === 401
  );
});