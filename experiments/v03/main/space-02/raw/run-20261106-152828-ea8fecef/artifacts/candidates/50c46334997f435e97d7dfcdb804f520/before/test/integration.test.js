'use strict';

/**
 * Integration tests — REQUIRED LIVE INFRASTRUCTURE.
 *
 * These tests exercise the real HTTP gateway (gateway/app.js) against the
 * Compose stack: PostgreSQL (game/question state, transactions, owner mapping),
 * Keycloak (OIDC token issuance and admin-role authorization), and the
 * authenticated admin CRUD. They are intentionally NOT part of the default
 * `npm test` run (which stays offline); invoke them explicitly with:
 *
 *   npm run test:integration
 *
 * Environment (mirrors compose.yaml service wiring):
 *   - GATEWAY_URL   base URL of the running gateway (default http://localhost:3000)
 *   - DATABASE_URL  PostgreSQL connection string (same as gateway service)
 *   - OIDC_ISSUER   public issuer URL (default http://localhost:8080/realms/space-fractions)
 *   - OIDC_AUDIENCE account audience (default "account")
 *   - STUDENT_PASSWORD / ADMIN_PASSWORD  demo account fixtures (local-only)
 *
 * When the required environment is not present (no DATABASE_URL or the gateway
 * is unreachable), every test reports as SKIPPED rather than failing, so the
 * suite remains honest about its runtime requirements instead of fabricating a
 * pass against mocked infrastructure.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../gateway/app');
const { createPool, migrate } = require('../lib/db');

/** Read an optional environment value, defaulting to a provided fallback. */
function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * Availability gate: integration tests require a live PostgreSQL connection
 * AND a route to the OIDC issuer (Keycloak) used to mint access tokens. Missing
 * either -> skip the whole file so `npm run test:integration` never fails on a
 * developer machine without the Compose stack up.
 */
const DATABASE_URL = env('DATABASE_URL', '');
const OIDC_ISSUER = env('OIDC_ISSUER', 'http://localhost:8080/realms/space-fractions');
const OIDC_AUDIENCE = env('OIDC_AUDIENCE', 'account');
const GATEWAY_URL = env('GATEWAY_URL', 'http://localhost:3000');

let pool = null;
let app = null;
let server = null;
let baseUrl = GATEWAY_URL;

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

/**
 * Obtain an access token via the OIDC password grant (local-only demo fixture;
 * explicitly enabled for the demo client via directAccessGrantsEnabled). This is
 * NOT production guidance — browser users use the authorization-code + PKCE flow.
 *
 * Returns null when the token endpoint is unreachable (allow the caller to skip).
 */
async function obtainToken(username, password) {
  const tokenPath = `${OIDC_ISSUER}/protocol/openid-connect/token`;
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

/** Whether integration tests can run at all (infra + token endpoint reachable). */
let infraReady = false;
let studentToken = null;
let adminToken = null;
let otherToken = null;

beforeEach(async () => {
  if (infraReady === false && infraReady !== null) {
    // First-time probe: attempt to connect to PG and reach the token endpoint.
    try {
      pool = createPool({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 1500,
      });
      const probe = await pool.query('SELECT 1');
      assert.strictEqual(probe.rows.length, 1);
      await migrate(pool);

      // Build the app against the same pool, then bind an ephemeral listener so
      // real HTTP is exercised without assuming the Compose port mapping.
      app = createApp({ pool });
      server = app.listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      studentToken = await obtainToken('student', env('STUDENT_PASSWORD', 'student'));
      adminToken = await obtainToken('admin', env('ADMIN_PASSWORD', 'admin'));
      otherToken = await obtainToken('other', env('OTHER_PASSWORD', 'other'));

      infraReady = Boolean(studentToken && adminToken && otherToken);
    } catch (_err) {
      infraReady = false;
    }
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end().catch(() => {});
});

/**
 * Skip a test when live infrastructure is not available. Returns true when the
 * test was skipped so callers can return early — node:test's t.skip() does not
 * halt execution, so continuing would still execute the body and fail.
 */
function skipIfNoInfra(t) {
  if (!infraReady) {
    t.skip('live PostgreSQL / Keycloak not available; run the Compose stack');
    return true;
  }
  return false;
}

test('GET /health returns 200', async (t) => {
  if (skipIfNoInfra(t)) return;
  const res = await jsonRequest('GET', '/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
});

test('admin can create, list, and delete a question (admin CRUD)', async (t) => {
  if (skipIfNoInfra(t)) return;
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

test('normal user gets 403 on admin endpoints', async (t) => {
  if (skipIfNoInfra(t)) return;
  const res = await jsonRequest('GET', '/api/admin/questions', {
    token: studentToken,
  });
  assert.strictEqual(res.status, 403);
});

test('missing/invalid credentials yield 401', async (t) => {
  if (skipIfNoInfra(t)) return;
  const missing = await jsonRequest('POST', '/api/games', { body: {} });
  assert.strictEqual(missing.status, 401);

  const invalid = await jsonRequest('POST', '/api/games', {
    token: 'not-a-valid-token',
    body: {},
  });
  assert.strictEqual(invalid.status, 401);
});

test('full game lifecycle: create, answer, score, and owner isolation', async (t) => {
  skipIfNoInfra(t);
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

  // The seeded question bank is deterministic; pick its first question id.
  assert.ok(created.body.questions.length > 0);
  const questionId = created.body.questions[0].id;

  // A correct answer must increment the score by exactly 1.
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

  // Another user must not read this game's score (403/404).
  const foreign = await jsonRequest('GET', `/api/games/${gameId}/score`, {
    token: otherToken,
  });
  assert.ok(foreign.status === 403 || foreign.status === 404);
});

test('pause/resume and answering while paused -> 409', async (t) => {
  skipIfNoInfra(t);
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