'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildApp, GAME_STATE } = require('../packages/game-service/src/index');
const {
  InMemoryGameRepository,
  DuplicateAnswerError,
} = require('../packages/game-service/src/repository');
const { createInvoker } = require('./helpers/http');

/**
 * Game-route integration tests (space-fractions.md lines 20-24, 32-34).
 *
 * These exercise the Express route layer of the game service end-to-end through
 * an in-process HTTP request helper, using the in-memory repository plus fake
 * verifier/user/event collaborators so the default `npm test` runs without
 * PostgreSQL, Redis, RabbitMQ, Elasticsearch or a live identity provider.
 *
 * Coverage: creation (optional fixed questionIds for reproducible practice),
 * game fetch (never leaking correctAnswer), pause/resume lifecycle, answer
 * submission scoring + transactional deduplication (409 on repeat), owner
 * authorization (other user's game -> 404), malformed fractions -> 400, and
 * missing/invalid credentials -> 401.
 */

/**
 * A fake OIDC verifier mirroring the real contract (verify(token) -> payload).
 * It derives `sub` from the presented `token-for-<sub>` token so that distinct
 * subjects resolve to distinct internal owners (as the real JWKS verifier does).
 */
function makeVerifier() {
  return {
    async verify(token) {
      const sub =
        typeof token === 'string' && token.startsWith('token-for-')
          ? token.slice('token-for-'.length)
          : 'student-sub';
      return { sub, preferred_username: sub.replace(/-sub$/, '') };
    },
  };
}

/** A fake user repository mapping subject -> numeric internal user id. */
function makeUserRepository(idMap = {}) {
  const values = Object.assign({ 'student-sub': 1, 'other-sub': 2 }, idMap);
  return {
    async findBySubject(sub) {
      const id = values[sub];
      return id === undefined ? null : { id, subject: sub };
    },
    async findOrCreateBySubject(sub) {
      if (values[sub] === undefined) {
        values[sub] = Math.max(0, ...Object.values(values)) + 1;
      }
      return { id: values[sub], subject: sub };
    },
  };
}

const QUESTIONS = [
  { id: 1, prompt: 'What is 1/2 + 1/4?', options: ['3/4', '2/6', '1/4'], correctAnswer: '3/4' },
  { id: 2, prompt: 'What is 1/2 of 2/3?', options: ['1/3', '2/6', '1/6'], correctAnswer: '1/3' },
  { id: 3, prompt: 'What is 3/4 - 1/2?', options: ['1/2', '1/4', '5/4'], correctAnswer: '1/4' },
];

function makeQuestionProvider(questions = QUESTIONS) {
  return {
    async list() {
      return questions.map((q) => ({ ...q, options: q.options.slice() }));
    },
    async get(id) {
      const q = questions.find((x) => x.id === id);
      return q ? { ...q, options: q.options.slice() } : null;
    },
  };
}

function makeApp(overrides = {}) {
  const repository = new InMemoryGameRepository();
  const app = buildApp({
    repository,
    questionProvider: makeQuestionProvider(),
    verifier: makeVerifier(),
    userRepository: makeUserRepository(),
    eventPublisher: { publishScore: async () => {} },
    logger: { error() {}, warn() {} },
    ...overrides,
  });
  return { app, repository };
}

/** Per-app memoized in-process HTTP servers (Ephemeral server per Express app). */
const invokerCache = new WeakMap();

async function getInvoker(app) {
  let pending = invokerCache.get(app);
  if (!pending) {
    pending = createInvoker(app);
    invokerCache.set(app, pending);
  }
  return pending;
}

/** Request wrapper returning a plain object; servers are created lazily per app. */
function request(app, sub) {
  const auth = sub ? { authorization: `Bearer token-for-${sub}` } : {};
  return {
    async post(path, body) { return (await getInvoker(app)).post(path, body, auth); },
    async get(path) { return (await getInvoker(app)).get(path, auth); },
  };
}

test('POST /api/games creates a game with all questions and no correctAnswer', async () => {
  const { app } = makeApp();
  const res = await request(app, 'student-sub').post('/api/games', {});
  assert.equal(res.status, 201);
  assert.equal(typeof res.body.id, 'number');
  assert.equal(res.body.state, GAME_STATE.IN_PROGRESS);
  assert.equal(res.body.questions.length, QUESTIONS.length);
  for (const q of res.body.questions) {
    assert.equal('correctAnswer' in q, false, 'correctAnswer must never leak to players');
    assert.ok(q.id && q.prompt && Array.isArray(q.options));
  }
});

test('POST /api/games accepts explicit questionIds for reproducible practice', async () => {
  const { app } = makeApp();
  const res = await request(app, 'student-sub').post('/api/games', { questionIds: [1, 3] });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.questions.map((q) => q.id), [1, 3]);
});

test('POST /api/games with an unknown questionId returns 404', async () => {
  const { app } = makeApp();
  const res = await request(app, 'student-sub').post('/api/games', { questionIds: [99] });
  assert.equal(res.status, 404);
});

test('GET /api/games/:id returns state without correctAnswer', async () => {
  const { app } = makeApp();
  const created = await request(app, 'student-sub').post('/api/games', {});
  const id = created.body.id;

  const res = await request(app, 'student-sub').get(`/api/games/${id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    id,
    state: GAME_STATE.IN_PROGRESS,
    score: 0,
    questions: created.body.questions,
  });
});

test('pause and resume mutate state and answering while paused returns 409', async () => {
  const { app } = makeApp();
  const created = await request(app, 'student-sub').post('/api/games', {});
  const id = created.body.id;

  const pause = await request(app, 'student-sub').post(`/api/games/${id}/pause`, {});
  assert.equal(pause.status, 200);
  assert.equal(pause.body.state, GAME_STATE.PAUSED);

  const blocked = await request(app, 'student-sub').post(
    `/api/games/${id}/answers`,
    { questionId: 1, answer: '3/4' },
  );
  assert.equal(blocked.status, 409);

  const resume = await request(app, 'student-sub').post(`/api/games/${id}/resume`, {});
  assert.equal(resume.status, 200);
  assert.equal(resume.body.state, GAME_STATE.IN_PROGRESS);

  const ok = await request(app, 'student-sub').post(
    `/api/games/${id}/answers`,
    { questionId: 1, answer: '3/4' },
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.correct, true);
});

test('answers aggregate score and repeat does not increment (409)', async () => {
  const { app } = makeApp();
  const created = await request(app, 'student-sub').post('/api/games', {});
  const id = created.body.id;

  const r1 = await request(app, 'student-sub').post(
    `/api/games/${id}/answers`,
    { questionId: 1, answer: '3/4' },
  );
  assert.deepEqual(r1.body, { correct: true, score: 1 });

  const repeat = await request(app, 'student-sub').post(
    `/api/games/${id}/answers`,
    { questionId: 1, answer: '3/4' },
  );
  assert.equal(repeat.status, 409);

  const score = await request(app, 'student-sub').get(`/api/games/${id}/score`);
  assert.deepEqual(score.body, { score: 1 });
});

test('other user\'s game is denied (404) with no existence leak', async () => {
  const { app } = makeApp();
  const created = await request(app, 'student-sub').post('/api/games', {});
  const id = created.body.id;

  const read = await request(app, 'other-sub').get(`/api/games/${id}`);
  assert.equal(read.status, 404);

  const score = await request(app, 'other-sub').get(`/api/games/${id}/score`);
  assert.equal(score.status, 404);

  const answer = await request(app, 'other-sub').post(
    `/api/games/${id}/answers`,
    { questionId: 1, answer: '3/4' },
  );
  assert.equal(answer.status, 404);
});

test('missing credentials return 401 on protected routes', async () => {
  const { app } = makeApp();
  const created = await request(app, 'student-sub').post('/api/games', {});
  const id = created.body.id;

  const create401 = await request(app).post('/api/games', {});
  assert.equal(create401.status, 401);

  const read401 = await request(app).get(`/api/games/${id}`);
  assert.equal(read401.status, 401);

  const answer401 = await request(app).post(
    `/api/games/${id}/answers`,
    { questionId: 1, answer: '3/4' },
  );
  assert.equal(answer401.status, 401);
});

test('malformed fraction answer returns 400', async () => {
  const { app } = makeApp();
  const created = await request(app, 'student-sub').post('/api/games', {});
  const id = created.body.id;

  const res = await request(app, 'student-sub').post(
    `/api/games/${id}/answers`,
    { questionId: 1, answer: 'three quarters' },
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'malformed_fraction');
});

test('invalid ids and payloads return 400', async () => {
  const { app } = makeApp();

  const badId = await request(app, 'student-sub').get('/api/games/not-a-number');
  assert.equal(badId.status, 400);

  const created = await request(app, 'student-sub').post('/api/games', {});
  const id = created.body.id;

  const noAnswer = await request(app, 'student-sub').post(
    `/api/games/${id}/answers`,
    { questionId: 1 },
  );
  assert.equal(noAnswer.status, 400);

  const noQid = await request(app, 'student-sub').post(
    `/api/games/${id}/answers`,
    { answer: '3/4' },
  );
  assert.equal(noQid.status, 400);
});

test('unknown question id on answer returns 404', async () => {
  const { app } = makeApp();
  const created = await request(app, 'student-sub').post('/api/games', {});
  const id = created.body.id;

  const res = await request(app, 'student-sub').post(
    `/api/games/${id}/answers`,
    { questionId: 999, answer: '3/4' },
  );
  assert.equal(res.status, 404);
});

test('GET /health is unauthenticated and returns 200', async () => {
  const { app } = makeApp();
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.service, 'game-service');
});