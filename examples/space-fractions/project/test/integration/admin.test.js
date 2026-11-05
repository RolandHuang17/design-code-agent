/**
 * Integration tests for the admin question CRUD HTTP contract.
 *
 * Exercises the REAL admin-service route module over HTTP with fakes injected
 * via the require cache (same approach as api.test.js / auth.test.js), so no
 * live PostgreSQL/Redis/RabbitMQ/Keycloak/Elasticsearch is required. The REAL
 * auth module performs structural + issuer/audience/expiry/nbf validation.
 *
 * Covered contract points (task T014 focus: error cases + authority):
 *   - POST   /api/admin/questions            -> 201, correctAnswer echoed to admin
 *   - GET    /api/admin/questions            -> 200 list (with correct_answer)
 *   - GET    /api/admin/questions/:id        -> 200 / 404
 *   - PUT    /api/admin/questions/:id        -> 200 / 404
 *   - DELETE /api/admin/questions/:id        -> 204 / 404
 *   - 401 for missing/invalid credentials; 403 for non-admin authenticated
 *   - 400 for malformed payloads (bad prompt, bad options, bad correctAnswer,
 *     correctAnswer not among options, invalid id, invalid limit)
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

// REAL auth module, configured to accept locally-crafted JWTs.
const auth = require('@spacefractions/shared/auth');
auth.configure({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE });

const adminRoutesPath = require.resolve('../../services/admin-service/src/routes');

function setupAdmin() {
  const fakeDb = createFakeDb();
  seedQuestions(fakeDb.store);
  fakeDb.store.nextQuestionId = 4;
  seedUsers(fakeDb.store);
  const fakeCache = createFakeCache();
  const fakeMq = createFakeMQ();
  const restore = installFakes({ db: fakeDb, cache: fakeCache, mq: fakeMq });

  delete require.cache[adminRoutesPath];
  const adminRoutes = require(adminRoutesPath);

  return { fakeDb, fakeCache, fakeMq, adminRoutes, restore };
}

async function setupAdminApp() {
  const s = setupAdmin();
  const app = await startApp(s.adminRoutes, '/api/admin');
  return { ...s, ...app };
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token) {
  return { ...authHeader(token), 'Content-Type': 'application/json' };
}

const VALID_PAYLOAD = {
  prompt: 'What is 2/3 + 1/3?',
  options: ['1/3', '2/3', '1', '3/3'],
  correctAnswer: '1'
};

// ---------------------------------------------------------------------------
// 401: missing / malformed / invalid credentials
// ---------------------------------------------------------------------------

test('admin CRUD without credentials returns 401', async () => {
  const t = await setupAdminApp();
  try {
    const cases = [
      ['/questions', 'GET'],
      ['/questions', 'POST'],
      ['/questions/1', 'GET'],
      ['/questions/1', 'PUT'],
      ['/questions/1', 'DELETE']
    ];
    for (const [p, method] of cases) {
      const opts = { method };
      if (method === 'POST' || method === 'PUT') {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(VALID_PAYLOAD);
      }
      const res = await t.request(p, opts);
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
    const bad = makeToken({ iss: 'https://evil.example', roles: ['admin'] });
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
    const expired = makeToken({
      sub: 'admin-user-sub',
      roles: ['admin'],
      exp: Math.floor(Date.now() / 1000) - 60
    });
    const res = await t.request('/questions', { headers: authHeader(expired) });
    assert.equal(res.status, 401);
  } finally {
    await t.close();
    t.restore();
  }
});

// ---------------------------------------------------------------------------
// 403: authenticated but missing the admin realm role
// ---------------------------------------------------------------------------

test('authenticated non-admin gets 403 on every admin endpoint', async () => {
  const t = await setupAdminApp();
  try {
    let res = await t.request('/questions', { headers: authHeader(STUDENT_TOKEN()) });
    assert.equal(res.status, 403, 'list');

    res = await t.request('/questions', {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify(VALID_PAYLOAD)
    });
    assert.equal(res.status, 403, 'create');

    res = await t.request('/questions/1', { headers: authHeader(STUDENT_TOKEN()) });
    assert.equal(res.status, 403, 'get');

    res = await t.request('/questions/1', {
      method: 'PUT',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify(VALID_PAYLOAD)
    });
    assert.equal(res.status, 403, 'update');

    res = await t.request('/questions/1', {
      method: 'DELETE',
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(res.status, 403, 'delete');
  } finally {
    await t.close();
    t.restore();
  }
});

// ---------------------------------------------------------------------------
// 201 / 200 / 204: successful admin CRUD
// ---------------------------------------------------------------------------

test('admin create returns 201 with correctAnswer and normalized id', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions', {
      method: 'POST',
      headers: jsonHeaders(ADMIN_TOKEN()),
      body: JSON.stringify(VALID_PAYLOAD)
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
    assert.equal(body.prompt, VALID_PAYLOAD.prompt);
    assert.deepEqual(body.options, VALID_PAYLOAD.options);
    assert.equal(body.correctAnswer, '1');
    assert.ok(body.createdAt, 'admin create includes createdAt');
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin create normalizes equivalent correctAnswer to canonical form', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions', {
      method: 'POST',
      headers: jsonHeaders(ADMIN_TOKEN()),
      body: JSON.stringify({
        prompt: 'What is 1/2 of 1?',
        options: ['1/2', '1/4', '3/4', '1'],
        correctAnswer: '2/4'
      })
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.correctAnswer, '1/2', '2/4 normalizes to 1/2');
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin list returns all seeded questions with correctAnswer (200)', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions', { headers: authHeader(ADMIN_TOKEN()) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.questions));
    assert.equal(body.count, 3);
    assert.equal(body.questions.length, 3);
    for (const q of body.questions) {
      assert.ok(q.id, 'each question has id');
      assert.ok(typeof q.correctAnswer === 'string', 'correctAnswer present for admin');
      assert.ok(Array.isArray(q.options));
    }
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin list supports ?limit=', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions?limit=2', { headers: authHeader(ADMIN_TOKEN()) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.questions.length, 2);
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin get single question returns 200 with correctAnswer', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions/1', { headers: authHeader(ADMIN_TOKEN()) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 1);
    assert.equal(body.correctAnswer, '3/4');
    assert.equal(body.prompt, 'What is 1/2 + 1/4?');
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin update (PUT) returns 200 and replaces the question', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions/1', {
      method: 'PUT',
      headers: jsonHeaders(ADMIN_TOKEN()),
      body: JSON.stringify({
        prompt: 'What is 1/2 + 1/4? (edited)',
        options: ['1/6', '3/4', '2/6', '1/8'],
        correctAnswer: '3/4'
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 1);
    assert.equal(body.prompt, 'What is 1/2 + 1/4? (edited)');
    assert.equal(body.correctAnswer, '3/4');

    const got = await t.request('/questions/1', { headers: authHeader(ADMIN_TOKEN()) });
    assert.equal((await got.json()).prompt, 'What is 1/2 + 1/4? (edited)');
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin delete returns 204 and the question is gone (404 afterwards)', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions/1', {
      method: 'DELETE',
      headers: authHeader(ADMIN_TOKEN())
    });
    assert.equal(res.status, 204);

    const got = await t.request('/questions/1', { headers: authHeader(ADMIN_TOKEN()) });
    assert.equal(got.status, 404);

    const list = await t.request('/questions', { headers: authHeader(ADMIN_TOKEN()) });
    assert.equal((await list.json()).count, 2);
  } finally {
    await t.close();
    t.restore();
  }
});

// ---------------------------------------------------------------------------
// 400: malformed payloads and invalid ids/limits
// ---------------------------------------------------------------------------

test('malformed create payloads return 400', async () => {
  const t = await setupAdminApp();
  try {
    const badPayloads = [
      {},                                                        // missing everything
      { prompt: '', options: ['1/2', '1/4'], correctAnswer: '1/2' }, // blank prompt
      { prompt: 'p', options: ['1/2'], correctAnswer: '1/2' },     // < 2 options
      { prompt: 'p', options: ['1/2', '1/2'], correctAnswer: '1/2' }, // duplicate options
      { prompt: 'p', options: ['1/2', '1/4'], correctAnswer: 'abc' }, // malformed fraction
      { prompt: 'p', options: ['1/2', '1/4'], correctAnswer: '1/0' }, // denominator 0
      { prompt: 'p', options: ['1/2', '1/4'], correctAnswer: '3/4' }, // not among options
      { prompt: 'p', options: ['1/2', ''], correctAnswer: '1/2' },    // blank option
      { prompt: 'p', options: '1/2', correctAnswer: '1/2' }           // options not array
    ];
    for (const payload of badPayloads) {
      const res = await t.request('/questions', {
        method: 'POST',
        headers: jsonHeaders(ADMIN_TOKEN()),
        body: JSON.stringify(payload)
      });
      assert.equal(res.status, 400, `payload ${JSON.stringify(payload)} should be 400`);
    }
  } finally {
    await t.close();
    t.restore();
  }
});

test('invalid question id (non-numeric / zero / negative) returns 400', async () => {
  const t = await setupAdminApp();
  try {
    for (const id of ['abc', '0', '-1']) {
      const getRes = await t.request(`/questions/${id}`, { headers: authHeader(ADMIN_TOKEN()) });
      assert.equal(getRes.status, 400, `GET id=${id}`);

      const delRes = await t.request(`/questions/${id}`, {
        method: 'DELETE',
        headers: authHeader(ADMIN_TOKEN())
      });
      assert.equal(delRes.status, 400, `DELETE id=${id}`);
    }
  } finally {
    await t.close();
    t.restore();
  }
});

test('invalid limit returns 400', async () => {
  const t = await setupAdminApp();
  try {
    for (const limit of ['0', '-1', 'abc', '501']) {
      const res = await t.request(`/questions?limit=${limit}`, {
        headers: authHeader(ADMIN_TOKEN())
      });
      assert.equal(res.status, 400, `limit=${limit} should be 400`);
    }
  } finally {
    await t.close();
    t.restore();
  }
});

test('update/delete on a non-existent question returns 404', async () => {
  const t = await setupAdminApp();
  try {
    const putRes = await t.request('/questions/999', {
      method: 'PUT',
      headers: jsonHeaders(ADMIN_TOKEN()),
      body: JSON.stringify(VALID_PAYLOAD)
    });
    assert.equal(putRes.status, 404);

    const delRes = await t.request('/questions/999', {
      method: 'DELETE',
      headers: authHeader(ADMIN_TOKEN())
    });
    assert.equal(delRes.status, 404);

    const getRes = await t.request('/questions/999', { headers: authHeader(ADMIN_TOKEN()) });
    assert.equal(getRes.status, 404);
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin cannot create with correctAnswer absent from options', async () => {
  const t = await setupAdminApp();
  try {
    const res = await t.request('/questions', {
      method: 'POST',
      headers: jsonHeaders(ADMIN_TOKEN()),
      body: JSON.stringify({
        prompt: 'What is 5/8?',
        options: ['1/2', '1/4', '3/4', '1'],
        correctAnswer: '5/8'
      })
    });
    assert.equal(res.status, 400);
  } finally {
    await t.close();
    t.restore();
  }
});