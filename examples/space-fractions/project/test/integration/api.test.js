/**
 * Integration tests for the Space Fractions HTTP API contract.
 *
 * These tests exercise the REAL game-service route module over HTTP, with a
 * fake in-memory PostgreSQL module (`@spacefractions/shared/db`) injected via
 * the require cache, so no live infrastructure is required. The REAL auth
 * middleware (`requireAuth` -> `validateToken`) is used; it performs
 * structural + issuer/audience/expiry validation. Signature/JWKS verification
 * is covered separately by the acceptance `auth` profile.
 *
 * Covered contract points:
 *   - POST /api/games             (create game, reproducible practice)
 *   - GET  /api/games/:id         (game state, no correctAnswer leak)
 *   - POST /api/games/:id/pause   (pause)
 *   - POST /api/games/:id/resume  (resume)
 *   - POST /api/games/:id/answers (answer + scoring idempotency)
 *   - GET  /api/games/:id/score   (score)
 *   - 401 (missing/invalid credential), 403/404 (cross-user), 400 (malformed
 *     fraction), 409 (answer while paused)
 *
 * Run with: `npm run test:integration` (does NOT require infra).
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
  OTHER_TOKEN,
  installFakes,
  seedQuestions
} = require('./_helpers');

// We use the REAL auth module, so it must be configured with matching
// issuer/audience for validateToken to accept our locally-crafted JWTs.
const auth = require('@spacefractions/shared/auth');
auth.configure({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE });

const gameRoutesPath = require.resolve('../../services/game-service/src/routes');

function setup() {
  const fakeDb = createFakeDb();
  seedQuestions(fakeDb.store);
  // Reset game id sequence so tests are deterministic (questions seeded first).
  fakeDb.store.nextGameId = 1;
  fakeDb.store.nextAnswerId = 1;
  const fakeCache = createFakeCache();
  const fakeMq = createFakeMQ();
  const restore = installFakes({ db: fakeDb, cache: fakeCache, mq: fakeMq });

  // Re-require the routes (and engine) against the fake modules.
  delete require.cache[gameRoutesPath];
  const gameRoutes = require(gameRoutesPath);

  return { fakeDb, fakeCache, fakeMq, gameRoutes, restore };
}

const { startApp } = require('./_helpers');

async function setupApp() {
  const s = setup();
  const app = await startApp(s.gameRoutes, '/api/games');
  return { ...s, ...app };
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

test('POST /api/games requires authentication (401)', async () => {
  const t = await setupApp();
  try {
    const res = await t.request('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 401);
  } finally {
    await t.close();
    t.restore();
  }
});

test('POST /api/games rejects an invalid token (401)', async () => {
  const t = await setupApp();
  try {
    // Token with wrong issuer (structural + issuer validation fails).
    const bad = makeToken({ iss: 'https://evil.example' });
    const res = await t.request('/api/games', {
      method: 'POST',
      headers: { ...authHeader(bad), 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 401);
  } finally {
    await t.close();
    t.restore();
  }
});

test('POST /api/games creates a game with questions (201, no correctAnswer)', async () => {
  const t = await setupApp();
  try {
    const res = await t.request('/api/games', {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionIds: [1, 2] })
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
    assert.equal(body.state, 'playing');
    assert.equal(body.questions.length, 2);
    for (const q of body.questions) {
      assert.ok(q.prompt);
      assert.ok(Array.isArray(q.options));
      assert.equal(q.correctAnswer, undefined, 'correctAnswer must not leak');
    }
  } finally {
    await t.close();
    t.restore();
  }
});

test('POST /api/games without questionIds uses all questions', async () => {
  const t = await setupApp();
  try {
    const res = await t.request('/api/games', {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.questions.length, 3);
  } finally {
    await t.close();
    t.restore();
  }
});

test('GET /api/games/:id returns state and never leaks correctAnswer', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1, 2] })
      })
    ).json();

    const res = await t.request(`/api/games/${created.id}`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, created.id);
    assert.equal(body.state, 'playing');
    assert.equal(typeof body.score, 'number');
    for (const q of body.questions) {
      assert.equal(q.correctAnswer, undefined, 'correctAnswer must not leak');
    }
  } finally {
    await t.close();
    t.restore();
  }
});

test('GET /api/games/:id by another user returns 404', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1, 2] })
      })
    ).json();

    const res = await t.request(`/api/games/${created.id}`, {
      headers: authHeader(OTHER_TOKEN())
    });
    assert.equal(res.status, 404);
  } finally {
    await t.close();
    t.restore();
  }
});

test('GET /api/games/:id by admin succeeds even when not owner', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1, 2] })
      })
    ).json();

    const res = await t.request(`/api/games/${created.id}`, {
      headers: authHeader(ADMIN_TOKEN())
    });
    assert.equal(res.status, 200);
  } finally {
    await t.close();
    t.restore();
  }
});

test('pause then resume round-trip (200 each), answering while paused is 409', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    const pauseRes = await t.request(`/api/games/${created.id}/pause`, {
      method: 'POST',
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(pauseRes.status, 200);
    assert.equal((await pauseRes.json()).state, 'paused');

    // Answering while paused -> 409
    const answerRes = await t.request(`/api/games/${created.id}/answers`, {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });
    assert.equal(answerRes.status, 409);

    const resumeRes = await t.request(`/api/games/${created.id}/resume`, {
      method: 'POST',
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(resumeRes.status, 200);
    assert.equal((await resumeRes.json()).state, 'playing');
  } finally {
    await t.close();
    t.restore();
  }
});

test('pause is idempotent (200 when already paused)', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    await t.request(`/api/games/${created.id}/pause`, {
      method: 'POST',
      headers: authHeader(STUDENT_TOKEN())
    });
    const again = await t.request(`/api/games/${created.id}/pause`, {
      method: 'POST',
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(again.status, 200);
  } finally {
    await t.close();
    t.restore();
  }
});

test('pause by another user returns 404 (no cross-user state change)', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    const res = await t.request(`/api/games/${created.id}/pause`, {
      method: 'POST',
      headers: authHeader(OTHER_TOKEN())
    });
    assert.equal(res.status, 404);
  } finally {
    await t.close();
    t.restore();
  }
});

test('correct answer scores 1 and returns correct:true', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    const res = await t.request(`/api/games/${created.id}/answers`, {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.correct, true);
    assert.equal(body.score, 1);

    const scoreRes = await t.request(`/api/games/${created.id}/score`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(scoreRes.status, 200);
    assert.equal((await scoreRes.json()).score, 1);
  } finally {
    await t.close();
    t.restore();
  }
});

test('wrong answer scores 0 and returns correct:false', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    const res = await t.request(`/api/games/${created.id}/answers`, {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 1, answer: '1/6' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.correct, false);
    assert.equal(body.score, 0);
  } finally {
    await t.close();
    t.restore();
  }
});

test('re-answering a correctly-answered question does not increase score (idempotent)', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1, 2] })
      })
    ).json();

    // Answer question 1 correctly (advances index).
    await t.request(`/api/games/${created.id}/answers`, {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });

    // Re-answer question 1 (now behind current index) — must not rescore.
    const res = await t.request(`/api/games/${created.id}/answers`, {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.correct, true);
    assert.equal(body.score, 1);

    const scoreRes = await t.request(`/api/games/${created.id}/score`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal((await scoreRes.json()).score, 1);
  } finally {
    await t.close();
    t.restore();
  }
});

test('answer uses exact rational equivalence (unreduced fraction accepted)', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    // 3/4 == 6/8 == 75/100 via exact rational reduction
    const res = await t.request(`/api/games/${created.id}/answers`, {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 1, answer: '6/8' })
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).correct, true);
  } finally {
    await t.close();
    t.restore();
  }
});

test('malformed fraction answer is rejected with 400', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    for (const bad of ['abc', '1/0', '1//2', '1 / a', ''] ) {
      const res = await t.request(`/api/games/${created.id}/answers`, {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: 1, answer: bad })
      });
      assert.equal(res.status, 400, `answer "${bad}" should be 400`);
    }
  } finally {
    await t.close();
    t.restore();
  }
});

test('answering a question not in the game returns 400', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    const res = await t.request(`/api/games/${created.id}/answers`, {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 999, answer: '1/2' })
    });
    assert.equal(res.status, 400);
  } finally {
    await t.close();
    t.restore();
  }
});

test('missing questionId/answer body is rejected with 400', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    const res = await t.request(`/api/games/${created.id}/answers`, {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 1 })
    });
    assert.equal(res.status, 400);
  } finally {
    await t.close();
    t.restore();
  }
});

test('completing all questions transitions game to completed', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    await t.request(`/api/games/${created.id}/answers`, {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });

    const res = await t.request(`/api/games/${created.id}`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, 'completed');
  } finally {
    await t.close();
    t.restore();
  }
});

test('score endpoint by another user returns 404', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    const res = await t.request(`/api/games/${created.id}/score`, {
      headers: authHeader(OTHER_TOKEN())
    });
    assert.equal(res.status, 404);
  } finally {
    await t.close();
    t.restore();
  }
});

test('score endpoint publishes a score event on first correct answer', async () => {
  const t = await setupApp();
  try {
    const created = await (
      await t.request('/api/games', {
        method: 'POST',
        headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionIds: [1] })
      })
    ).json();

    await t.request(`/api/games/${created.id}/answers`, {
      method: 'POST',
      headers: { ...authHeader(STUDENT_TOKEN()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });

    assert.equal(t.fakeMq.events.length, 1);
    assert.equal(t.fakeMq.events[0].gameId, created.id);
    assert.equal(t.fakeMq.events[0].score, 1);
  } finally {
    await t.close();
    t.restore();
  }
});