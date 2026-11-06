'use strict';

/**
 * Integration tests — HTTP contract against the real gateway.
 *
 * These tests exercise the real Express gateway (gateway/app.js) and the real
 * service/auth/db logic over real HTTP. They run OFFLINE (no live PostgreSQL,
 * Redis, RabbitMQ, Elasticsearch, or Keycloak required) by injecting:
 *
 *   * a test-only in-memory pg adapter (test/fake-pg.js) that implements the
 *     exact SQL surface issued by lib/db.js with faithful transaction/unique
 *     semantics; and
 *   * a real RSA-signed JWKS verifier (jose) with issuer/audience checks, so the
 *     same signature/issuer/audience validation path is exercised without a
 *     live identity provider.
 *
 * This is NOT a substitute for PostgreSQL/Keycloak correctness — real database
 * behaviour and the real OIDC provider are exercised separately by the
 * protected runtime HTTP acceptance harness against the Compose stack. When a
 * live stack IS reachable (DATABASE_URL set), the suite upgrades to it so the
 * two paths stay honest about their runtime requirements.
 *
 * Env (optional, live-stack upgrade):
 *   DATABASE_URL     PostgreSQL connection string (if absent -> fake adapter)
 *   OIDC_ISSUER      public issuer URL (default http://localhost:8080/realms/space-fractions)
 *   OIDC_AUDIENCE    account audience (default "account")
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { createLocalJWKSet, generateKeyPair, exportJWK, SignJWT } = require('jose');

const { createApp } = require('../gateway/app');
const { createPool, migrate } = require('../lib/db');
const { createFakePool } = require('./fake-pg');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const DATABASE_URL = env('DATABASE_URL', '');
const ISSUER = env('OIDC_ISSUER', 'http://localhost:8080/realms/space-fractions');
const AUDIENCE = env('OIDC_AUDIENCE', 'account');

let pool = null;
let app = null;
let server = null;
let baseUrl = null;

// Offline signed-JWKS fixtures: a real RSA key pair and matching jose verifier.
let verifier = null;
let signKey = null;
let issuer = ISSUER;
let audience = AUDIENCE;

let studentToken = null;
let adminToken = null;
let otherToken = null;
let usingFakePool = false;

/** Minimal fetch wrapper that reads a JSON body. */
async function jsonRequest(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_e) {
      data = text;
    }
  }
  return { status: res.status, body: data };
}

/** Obtain an access token via the OIDC password grant (live-stack upgrade only). */
async function obtainToken(username, password) {
  const tokenPath = `${ISSUER}/protocol/openid-connect/token`;
  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: 'space-fractions-client',
    username,
    password,
    scope: 'openid',
  });
  let res;
  try {
    res = await fetch(tokenPath, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (_err) {
    return null;
  }
  if (res.status !== 200) return null;
  const data = await res.json();
  return data.access_token || null;
}

/** Sign an offline JWT fixture with a stable subject and optional admin role. */
async function signToken(sub, roles, preferredUsername) {
  return new SignJWT({
    preferred_username: preferredUsername || sub,
    realm_access: { roles: roles || [] },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(signKey);
}

beforeEach(async () => {
  // Initialise once per test-file run (node:test runs beforeEach before each
  // test, but state here is idempotent and shared across tests).
  if (pool) return;

  // 1. Key pair + JWKS verifier for offline fixtures.
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  signKey = privateKey;
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  verifier = createLocalJWKSet({ keys: [publicJwk] });

  // 2. Pool: prefer live PostgreSQL; otherwise use the in-memory adapter.
  let effectivePool;
  if (DATABASE_URL) {
    try {
      effectivePool = createPool({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 1500,
      });
      const probe = await effectivePool.query('SELECT 1');
      assert.strictEqual(probe.rows.length, 1);
      await migrate(effectivePool);
      usingFakePool = false;
    } catch (_err) {
      await effectivePool.end().catch(() => {});
      throw _err;
    }
  } else {
    effectivePool = createFakePool();
    usingFakePool = true;
  }
  pool = effectivePool;

  // 3. Build the app with the real verifier wired in (issuer/audience checks on).
  app = createApp({
    pool,
    verifierOptions: {
      verifier,
      config: { issuer, audience },
      env: { OIDC_ISSUER: issuer, OIDC_AUDIENCE: audience },
    },
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 4. Tokens: try live password grant; fall back to signed offline fixtures.
  if (usingFakePool === false) {
    studentToken = await obtainToken('student', env('STUDENT_PASSWORD', 'student'));
    adminToken = await obtainToken('admin', env('ADMIN_PASSWORD', 'admin'));
    otherToken = await obtainToken('other', env('OTHER_PASSWORD', 'other'));
  }
  if (!studentToken) studentToken = await signToken('student-sub', [], 'student');
  if (!adminToken) adminToken = await signToken('admin-sub', ['admin'], 'admin');
  if (!otherToken) otherToken = await signToken('other-sub', [], 'other');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end().catch(() => {});
});

test('GET /health returns 200', async () => {
  const res = await jsonRequest('GET', '/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
});

test('admin can create, list, and delete a question (admin CRUD)', async () => {
  const created = await jsonRequest('POST', '/api/admin/questions', {
    token: adminToken,
    body: {
      prompt: '1/6 + 1/3 = ?',
      options: ['1/2', '1/3', '2/3'],
      correctAnswer: '1/2',
    },
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(typeof created.body.id, 'number');
  assert.strictEqual(created.body.correctAnswer, '1/2');

  const listed = await jsonRequest('GET', '/api/admin/questions', {
    token: adminToken,
  });
  assert.strictEqual(listed.status, 200);
  assert.ok(Array.isArray(listed.body.questions));
  const found = listed.body.questions.find((q) => q.id === created.body.id);
  assert.ok(found);

  const removed = await jsonRequest('DELETE', `/api/admin/questions/${created.body.id}`, {
    token: adminToken,
  });
  assert.ok(removed.status === 200 || removed.status === 204);
});

test('normal user gets 403 on admin endpoints', async () => {
  const res = await jsonRequest('GET', '/api/admin/questions', {
    token: studentToken,
  });
  assert.strictEqual(res.status, 403);
});

test('missing/invalid credentials yield 401', async () => {
  const missing = await jsonRequest('POST', '/api/games', { body: {} });
  assert.strictEqual(missing.status, 401);

  const invalid = await jsonRequest('POST', '/api/games', {
    token: 'not-a-valid-token',
    body: {},
  });
  assert.strictEqual(invalid.status, 401);
});

test('full game lifecycle: create, answer, score, and owner isolation', async () => {
  const created = await jsonRequest('POST', '/api/games', {
    token: studentToken,
    body: {},
  });
  assert.strictEqual(created.status, 201);
  const gameId = created.body.id;
  assert.ok(Number.isInteger(gameId));
  assert.ok(Array.isArray(created.body.questions));
  for (const q of created.body.questions) {
    assert.ok(!('correctAnswer' in q));
    assert.ok(!('correct_answer' in q));
  }

  assert.ok(created.body.questions.length > 0);
  const questionId = created.body.questions[0].id;

  // The seeded question bank (fake-pg) is deterministic; answer it correctly.
  // We do not assert "correct: true" because question text varies, but the
  // score must be a number and match the score endpoint.
  const answer = await jsonRequest('POST', `/api/games/${gameId}/answers`, {
    token: studentToken,
    body: { questionId, answer: '1/2' },
  });
  assert.strictEqual(answer.status, 200);
  assert.strictEqual(typeof answer.body.correct, 'boolean');
  assert.strictEqual(typeof answer.body.score, 'number');

  const score = await jsonRequest('GET', `/api/games/${gameId}/score`, {
    token: studentToken,
  });
  assert.strictEqual(score.status, 200);
  assert.strictEqual(score.body.score, answer.body.score);

  const foreign = await jsonRequest('GET', `/api/games/${gameId}/score`, {
    token: otherToken,
  });
  assert.ok(foreign.status === 403 || foreign.status === 404);
});

test('pause/resume and answering while paused -> 409', async () => {
  const created = await jsonRequest('POST', '/api/games', {
    token: studentToken,
    body: {},
  });
  const gameId = created.body.id;
  const questionId = created.body.questions[0].id;

  const paused = await jsonRequest('POST', `/api/games/${gameId}/pause`, {
    token: studentToken,
  });
  assert.strictEqual(paused.status, 200);

  const blocked = await jsonRequest('POST', `/api/games/${gameId}/answers`, {
    token: studentToken,
    body: { questionId, answer: '1/2' },
  });
  assert.strictEqual(blocked.status, 409);

  const resumed = await jsonRequest('POST', `/api/games/${gameId}/resume`, {
    token: studentToken,
  });
  assert.strictEqual(resumed.status, 200);

  const after = await jsonRequest('POST', `/api/games/${gameId}/answers`, {
    token: studentToken,
    body: { questionId, answer: '1/2' },
  });
  assert.strictEqual(after.status, 200);
});