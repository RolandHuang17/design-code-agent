/**
 * Integration tests for the end-to-end game flow of Space Fractions.
 *
 * This file (task T014) focuses on the *flow* of a game across its lifecycle,
 * complementing api.test.js (HTTP contract edge cases) and auth.test.js
 * (authorization matrix). Covered here:
 *   - Full lifecycle: create -> play -> answer all -> completed -> ending state.
 *   - Current-question progression through `currentQuestionIndex`.
 *   - Pause/resume mid-game and its interaction with subsequent answers.
 *   - Scoring across multiple questions (each correct answer = +1).
 *   - Score-event emission via RabbitMQ (fake MQ records calls).
 *   - Idempotent re-answer across the whole game (score never exceeds total).
 *   - Answering after completion -> 409.
 *   - Cross-user isolation on answers and score (404).
 *   - Score endpoint reflects cumulative score for owner.
 *
 * These tests use the REAL game-service route module + REAL auth module, with
 * fake db/cache/mq modules injected via the require cache, so no live infra is
 * required. Signature/JWKS verification is exercised by the separate
 * acceptance `auth` profile.
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
  ADMIN_TOKEN,
  STUDENT_TOKEN,
  OTHER_TOKEN,
  installFakes,
  seedQuestions,
  startApp
} = require('./_helpers');

// Use the REAL auth module configured to accept our locally-crafted JWTs.
const auth = require('@spacefractions/shared/auth');
auth.configure({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE });

const gameRoutesPath = require.resolve('../../services/game-service/src/routes');

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token) {
  return { ...authHeader(token), 'Content-Type': 'application/json' };
}

function setup() {
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

async function setupApp() {
  const s = setup();
  const app = await startApp(s.gameRoutes, '/api/games');
  return { ...s, ...app };
}

async function createGame(t, token, questionIds) {
  const res = await t.request('/api/games', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ questionIds })
  });
  assert.equal(res.status, 201);
  return res.json();
}

test('full game lifecycle: play three questions to completion with correct score', async () => {
  const t = await setupApp();
  try {
    const game = await createGame(t, STUDENT_TOKEN(), [1, 2, 3]);
    assert.equal(game.state, 'playing');
    assert.equal(game.currentQuestionIndex, 0);
    assert.equal(game.questions.length, 3);

    // Answer Q1 correctly (3/4)
    let res = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.correct, true);
    assert.equal(body.score, 1);
    assert.equal(body.gameState, 'playing');

    // Answer Q2 correctly (2/5)
    res = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 2, answer: '2/5' })
    });
    body = await res.json();
    assert.equal(body.correct, true);
    assert.equal(body.score, 2);
    assert.equal(body.gameState, 'playing');

    // Answer Q3 correctly (1/2) -> transitions to completed
    res = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 3, answer: '1/2' })
    });
    body = await res.json();
    assert.equal(body.correct, true);
    assert.equal(body.score, 3);
    assert.equal(body.gameState, 'completed');

    // Final score reflects 3/3
    const scoreRes = await t.request(`/api/games/${game.id}/score`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(scoreRes.status, 200);
    assert.equal((await scoreRes.json()).score, 3);

    // Game state is 'completed' on GET
    const getRes = await t.request(`/api/games/${game.id}`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal((await getRes.json()).state, 'completed');

    // Exactly 3 score events emitted, one per correct answer.
    assert.equal(t.fakeMq.events.length, 3);
    assert.deepEqual(
      t.fakeMq.events.map((e) => e.score).sort((a, b) => a - b),
      [1, 2, 3],
      'score events should reflect monotonically increasing score'
    );
    assert.ok(t.fakeMq.events.every((e) => e.gameId === game.id));
    assert.ok(t.fakeMq.events.every((e) => e.questionId));
  } finally {
    await t.close();
    t.restore();
  }
});

test('score only increments on correct answers across a mixed game', async () => {
  const t = await setupApp();
  try {
    const game = await createGame(t, STUDENT_TOKEN(), [1, 2, 3]);

    // Q1 correct (+1)
    await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });

    // Q2 wrong (+0), but still advances the current question
    let res = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 2, answer: '1/5' })
    });
    let body = await res.json();
    assert.equal(body.correct, false);
    assert.equal(body.score, 1, 'wrong answer does not change score');

    // Q3 correct (+1)
    res = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 3, answer: '1/2' })
    });
    body = await res.json();
    assert.equal(body.correct, true);
    assert.equal(body.score, 2);
    assert.equal(body.gameState, 'completed');

    const scoreRes = await t.request(`/api/games/${game.id}/score`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal((await scoreRes.json()).score, 2);

    // Only 2 score events (Q1 and Q3) were published.
    assert.equal(t.fakeMq.events.length, 2);
  } finally {
    await t.close();
    t.restore();
  }
});

test('paused game retains progress; resume allows answering next question', async () => {
  const t = await setupApp();
  try {
    const game = await createGame(t, STUDENT_TOKEN(), [1, 2]);

    // Answer Q1 correctly
    await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });

    // Pause
    let res = await t.request(`/api/games/${game.id}/pause`, {
      method: 'POST',
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, 'paused');

    // Progress is preserved while paused (index advanced to 1)
    const getRes = await t.request(`/api/games/${game.id}`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    const state = await getRes.json();
    assert.equal(state.state, 'paused');
    assert.equal(state.currentQuestionIndex, 1);
    assert.equal(state.score, 1);

    // Answering while paused -> 409, no state leaked
    res = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 2, answer: '2/5' })
    });
    assert.equal(res.status, 409);

    // Resume
    res = await t.request(`/api/games/${game.id}/resume`, {
      method: 'POST',
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, 'playing');

    // Now answer Q2 correctly -> completes at score 2
    res = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 2, answer: '2/5' })
    });
    const body = await res.json();
    assert.equal(body.correct, true);
    assert.equal(body.score, 2);
    assert.equal(body.gameState, 'completed');
  } finally {
    await t.close();
    t.restore();
  }
});

test('re-answering an already-correct question never increases score beyond total', async () => {
  const t = await setupApp();
  try {
    const game = await createGame(t, STUDENT_TOKEN(), [1]);

    // First correct answer
    await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });

    // Game is now completed; re-answering completed -> 409.
    const res = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });
    assert.equal(res.status, 409, 'answering a completed game is rejected');

    // Score remains 1.
    const scoreRes = await t.request(`/api/games/${game.id}/score`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal((await scoreRes.json()).score, 1);

    // Only one score event was published.
    assert.equal(t.fakeMq.events.length, 1);
  } finally {
    await t.close();
    t.restore();
  }
});

test('answering after completion is rejected with 409 (409 on completed)', async () => {
  const t = await setupApp();
  try {
    const game = await createGame(t, STUDENT_TOKEN(), [1]);

    await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });

    const res = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });
    assert.equal(res.status, 409);
  } finally {
    await t.close();
    t.restore();
  }
});

test('cross-user: another user cannot answer or read score (404)', async () => {
  const t = await setupApp();
  try {
    const game = await createGame(t, STUDENT_TOKEN(), [1]);

    // Other user answering -> 404 (ownership enforced).
    const answerRes = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(OTHER_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });
    assert.equal(answerRes.status, 404);

    // Other user reading score -> 404.
    const scoreRes = await t.request(`/api/games/${game.id}/score`, {
      headers: authHeader(OTHER_TOKEN())
    });
    assert.equal(scoreRes.status, 404);

    // Owner can still answer and score is unaffected by the other user's attempt.
    const ownerRes = await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });
    assert.equal(ownerRes.status, 200);
    assert.equal((await ownerRes.json()).score, 1);

    // No score event was recorded for the cross-user attempt.
    assert.equal(t.fakeMq.events.length, 1);
  } finally {
    await t.close();
    t.restore();
  }
});

test('cross-user pause attempt does not change owner state (404)', async () => {
  const t = await setupApp();
  try {
    const game = await createGame(t, STUDENT_TOKEN(), [1]);

    const res = await t.request(`/api/games/${game.id}/pause`, {
      method: 'POST',
      headers: authHeader(OTHER_TOKEN())
    });
    assert.equal(res.status, 404);

    // Owner state still 'playing'.
    const getRes = await t.request(`/api/games/${game.id}`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    assert.equal((await getRes.json()).state, 'playing');
  } finally {
    await t.close();
    t.restore();
  }
});

test('admin can read score but game endpoints never leak correctAnswer', async () => {
  const t = await setupApp();
  try {
    const game = await createGame(t, STUDENT_TOKEN(), [1, 2]);

    await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });

    const scoreRes = await t.request(`/api/games/${game.id}/score`, {
      headers: authHeader(ADMIN_TOKEN())
    });
    assert.equal(scoreRes.status, 200);
    assert.equal((await scoreRes.json()).score, 1);

    const getRes = await t.request(`/api/games/${game.id}`, {
      headers: authHeader(ADMIN_TOKEN())
    });
    const body = await getRes.json();
    for (const q of body.questions) {
      assert.equal(q.correctAnswer, undefined, 'admin view must not include correctAnswer');
    }
  } finally {
    await t.close();
    t.restore();
  }
});

test('score endpoint reflects cumulative total and state after partial answers', async () => {
  const t = await setupApp();
  try {
    const game = await createGame(t, STUDENT_TOKEN(), [1, 2, 3]);

    // No answers yet -> score 0, playing
    let scoreRes = await t.request(`/api/games/${game.id}/score`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    let body = await scoreRes.json();
    assert.equal(body.score, 0);
    assert.equal(body.state, 'playing');

    // Answer Q1 -> score 1
    await t.request(`/api/games/${game.id}/answers`, {
      method: 'POST',
      headers: jsonHeaders(STUDENT_TOKEN()),
      body: JSON.stringify({ questionId: 1, answer: '3/4' })
    });
    scoreRes = await t.request(`/api/games/${game.id}/score`, {
      headers: authHeader(STUDENT_TOKEN())
    });
    body = await scoreRes.json();
    assert.equal(body.score, 1);
    assert.equal(body.state, 'playing');
  } finally {
    await t.close();
    t.restore();
  }
});