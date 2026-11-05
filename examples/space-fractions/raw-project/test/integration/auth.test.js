/**
 * Integration tests for authentication & authorization across the API.
 *
 * Focus (per task T014 "authorization"):
 *   - Missing/invalid credential -> 401 on protected endpoints.
 *   - Authenticated non-admin user -> 403 on admin-only endpoints.
 *   - Admin user -> succeeds on admin-only endpoints (question CRUD).
 *   - Admin endpoints never require infra; exercise the REAL admin-service
 *     route module over HTTP with fake DB/cache/mq/auth injected via the
 *     require cache (same approach as api.test.js).
 *   - Player-facing game endpoints only require any authenticated user.
 *
 * Note on signature verification: the REAL auth module's validateToken
 * performs structural + issuer/audience/expiry/nbf validation. Full RSA/JWKS
 * signature verification is covered by the separate acceptance `auth` profile
 * (run independently; does not require this test suite).
 *
 * Run with: `npm run test:integration` (does NOT require live infra).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ISSUER,
  AUDIENCE,
  createFakeDb,
  createFakeCache,
  createFakeMQ,
  makeToken,
  ADMIN_TOKEN,
  STUDENT_TOKEN,
  installFakes,
  seedQuestions,
  seedUsers,
  startApp
} = require('./_helpers');

// Use the REAL auth module configured to accept our locally-crafted JWTs.
const auth = require('@spacefractions/shared/auth');
auth.configure({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE });

const adminRoutesPath = require.resolve('../../services/admin-service/src/routes');
const gameRoutesPath = require.resolve('../../services/game-service/src/routes');

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token) {
  return { ...authHeader(token), 'Content-Type': 'application/json' };
}

/**
 * Set up fakes and (re)require the admin routes against them. Admin routes
 * pull in the Elasticsearch search helper; its index/delete operations are
 * fire-and-forget and non-fatal, so no fake ES client is required as long as
 * `@elastic/elasticsearch` is installed (it is a declared dependency).
 */
function setupAdmin() {
  const fakeDb = createFakeDb();
  seedQuestions(fakeDb.store);
  seedUsers(fakeDb.store);
  const fakeCache = createFakeCache();
  const fakeMq = createFakeMQ();
  const restore = installFakes({ db: fakeDb, cache: fakeCache, mq: fakeMq });

  delete require.cache[adminRoutesPath];
  delete require.cache[require.resolve('../../services/admin-service/src/routes.js')];
  const adminRoutes = require(adminRoutesPath);

  return { fakeDb, fakeCache, fakeMq, adminRoutes, restore };
}

async function setupAdminApp() {
  const s = setupAdmin();
  const app = await startApp(s.adminRoutes, '/api/admin');
  return { ...s, ...app };
}

// ---------------------------------------------------------------------------
// 401: missing / malformed credentials
// ---------------------------------------------------------------------------

test('admin endpoints without credentials return 401', async () => {
  const t = await setupAdminApp();
  try {
    const paths = [
      ['/questions', 'GET'],
      ['/questions', 'POST'],
      ['/questions/1', 'DELETE']
    ];
    for (const [p, method] of paths) {
      const req = t.request(p, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {})
      });
      const res = await req;
      assert.equal(res.status, 401, `${method} ${p} should be 401 without token`);
    }
  } finally {
    await t.close();
    t.restore();
  }
});

test('malformed Authorization header returns 401', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' }
    });
    assert.equal(res.status, 401);
  } finally {
    await t.close();
    t.restore();
  }
});

test('token with wrong issuer is rejected (401)', async () => {
  const t = await setupAdminApp();
  try {
    const bad = makeToken({ iss: 'https://evil.example' });
    const res = await t.request('/questions', { headers: authHeader(bad) });
    assert.equal(res.status, 401);
  } finally {
    await t.close();
    t.restore();
  }
});

test('expired token is rejected (401)', async () => {
  const t = await setupAdminApp();
  try {
    const expired = makeToken({ sub: 'admin-user-sub', roles: ['admin'], exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await t.request('/questions', { headers: authHeader(expired) });
    assert.equal(res.status, 401);
  } finally {
    await t.close();
    t.restore();
  }
});

test('token with wrong audience is rejected (401)', async () => {
  const t = await setupAdminApp();
  try {
    const badAud = makeToken({ sub: 'admin-user-sub', roles: ['admin'], aud: 'other-client' });
    const res = await t.request('/questions', { headers: authHeader(badAud) });
    assert.equal(res.status, 401);
  } finally {
    await t.close();
    t.restore();
  }
});

// ---------------------------------------------------------------------------
// 403: authenticated but missing the admin role
// ---------------------------------------------------------------------------

test('authenticated non-admin user gets 403 on admin endpoints', async () => {
  const t = await setupAdminApp();
  try {
    // POST create
    let res = await t.request('/questions', {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({
        prompt: 'What is 1/2 + 1/2?',
        options: ['1/4', '1/2', '1', '2/4'],
        correctAnswer: '1'
      })
    });
    assert.equal(res.status, 403, 'non-admin create should be 403');

    // GET list
    res = await t.request('/questions', { headers: authHeader(STUDENT_TOKEN()) });
    assert.equal(res.status, 403, 'non-admin list should be 403');

    // DELETE
    res = await t.request('/questions/1', {
      method: 'DELETE',
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(res.status, 403, 'non-admin delete should be 403');
  } finally {
    await t.close();
    t.restore();
  }
});

// ---------------------------------------------------------------------------
// 200/201/204: admin role succeeds on admin CRUD
// ---------------------------------------------------------------------------

test('admin can create a question (201) with correct_answer visible', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions', {
      method: 'POST',
      headers: jsonHeaders(ADMIN_TOKEN()),
      body: JSON.stringify({
        prompt: 'What is 2/3 + 1/3?',
        options: ['1/3', '2/3', '1', '3/3'],
        correctAnswer: '1'
      })
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id, 'created question should have an id');
    assert.equal(body.prompt, 'What is 2/3 + 1/3?');
    assert.equal(body.correctAnswer, '1', 'admin response includes correctAnswer');
    assert.deepEqual(body.options, ['1/3', '2/3', '1', '3/3']);
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin can list questions (200) with correct_answer included', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions', { headers: authHeader(ADMIN_TOKEN()) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.questions));
    assert.equal(body.questions.length, 3, 'seed provides 3 questions');
    const q = body.questions[0];
    assert.ok(q.correctAnswer !== undefined, 'admin list includes correctAnswer');
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin can get a single question (200) with correct_answer', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions/1', { headers: authHeader(ADMIN_TOKEN()) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 1);
    assert.equal(body.correctAnswer, '3/4');
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin can update a question (200)', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions/1', {
      method: 'PUT',
      headers: jsonHeaders(ADMIN_TOKEN()),
      body: JSON.stringify({
        prompt: 'What is 1/2 + 1/4?',
        options: ['1/6', '3/4', '2/6', '1/8'],
        correctAnswer: '6/8' // equivalent to 3/4, still one of the options
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 1);
    assert.equal(body.correctAnswer, '3/4', 'correct answer is normalized to reduced form');
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin can delete a question (204)', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions/1', {
      method: 'DELETE',
      headers: authHeader(ADMIN_TOKEN())
    });
    assert.equal(res.status, 204);

    // Now gone: GET should 404 (admin, but question missing).
    const getRes = await t.request('/questions/1', { headers: authHeader(ADMIN_TOKEN()) });
    assert.equal(getRes.status, 404);
  } finally {
    await t.close();
    t.restore();
  }
});

// ---------------------------------------------------------------------------
// Cross-cutting: game endpoints require any authenticated user, support admin
// ---------------------------------------------------------------------------

function setupGame() {
  const fakeDb = createFakeDb();
  seedQuestions(fakeDb.store);
  fakeDb.store.nextGameId = 1;
  fakeDb.store.nextAnswerId = 1;
  const fakeCache = createFakeCache();
  const fakeMq = createFakeMQ();
  const restore = installFakes({ db: fakeDb, cache: fakeCache, mq: fakeMq });

  delete require.cache[gameRoutesPath];
  delete require.cache[require.resolve('../../services/game-service/src/game-engine.js')];
  const gameRoutes = require(gameRoutesPath);

  return { fakeDb, fakeCache, fakeMq, gameRoutes, restore };
}

async function setupGameApp() {
  const s = setupGame();
  const app = await startApp(s.gameRoutes, '/api/games');
  return { ...s, ...app };
}

test('game creation requires authentication (401) but works for any user (201)', async () => {
  const t = await setupGameApp();
  try {
    // No token -> 401
    let res = await t.request('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionIds: [1] })
    });
    assert.equal(res.status, 401);

    // Student (non-admin) token -> 201
    res = await t.request('/api/games', {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionIds: [1] })
    });
    assert.equal(res.status, 201);
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin role does not leak correctAnswer through game endpoints', async () => {
  const t = await setupGameApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: jsonHeaders(ADMIN_TOKEN()),
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    const res = await t.request(`/api/games/${created.id}`, {
      headers: authHeader(ADMIN_TOKEN())
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const q of body.questions) {
      assert.equal(q.correctAnswer, undefined, 'even admins never see correctAnswer in game state');
    }
  } finally {
    await t.close();
    t.restore();
  }
});