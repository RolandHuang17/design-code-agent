'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildApp, GAME_STATE } = require('../packages/game-service/src/index');
const {
  InMemoryGameRepository,
  DuplicateAnswerError,
} = require('../packages/game-service/src/repository');
const { validateAnswer } = require('../src/shared/fraction');
const { createInvoker } = require('./helpers/http');

/**
 * Scoring and pause/resume behavior tests for the game service.
 *
 * These use the in-memory repository plus fake collaborators so the default
 * `npm test` runs without PostgreSQL, Redis, RabbitMQ or an identity provider,
 * while still exercising the real route handlers, transactional deduplication
 * semantics and owner authorization (space-fractions.md lines 20-24, 32-34).
 */

/** A fake OIDC verifier that claims any presented Bearer token as `sub`. */
function makeVerifier(sub = 'student-sub') {
  return {
    async verify() {
      return { sub, preferred_username: 'student' };
    },
  };
}

/** A fake user repository mapping a subject to a numeric internal user id. */
function makeUserRepository(idMap = {}) {
  const values = Object.assign({ 'student-sub': 1, 'other-sub': 2 }, idMap);
  return {
    async findBySubject(sub) {
      const id = values[sub];
      return id === undefined ? null : { id, subject: sub };
    },
    async findOrCreateBySubject(sub) {
      if (values[sub] === undefined) values[sub] = Math.max(...Object.values(values), 0) + 1;
      return { id: values[sub], subject: sub };
    },
  };
}

const QUESTIONS = [
  { id: 1, prompt: 'What is 1/2 + 1/4?', options: ['3/4', '2/6', '1/4'], correctAnswer: '3/4' },
  { id: 2, prompt: 'What is 1/2 of 2/3?', options: ['1/3', '2/6', '1/6'], correctAnswer: '1/3' },
  { id: 3, prompt: 'What is 3/4 - 1/2?', options: ['1/2', '1/4', '5/4'], correctAnswer: '1/4' },
];

/** A fake question provider exposing the fixed pool. */
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

/** Create a game and return its id plus request/answer helpers. */
async function makeGame(jwtSub = 'student-sub', app = null) {
  const a = app || makeApp();
  const createRes = await request(app, a.app).post('/api/games', {}, auth(jwtSub));
  assert.equal(createRes.status, 201, 'game creation should succeed');
  return { id: createRes.body.id, app: a };
}

function auth(sub = 'student-sub') {
  return { authorization: `Bearer token-for-${sub}` };
}

function makeApp() {
  const repository = new InMemoryGameRepository();
  const app = buildApp({
    repository,
    questionProvider: makeQuestionProvider(),
    verifier: makeVerifier(),
    userRepository: makeUserRepository(),
    eventPublisher: { publishScore: async () => {} },
  });
  return { app, repository };
}

/** Minimal in-process HTTP helper around the Express app (no live listener). */
function httpInvoke(app) {
  return {
    post(path, body, headers = {}) {
      return invoke(app, 'POST', path, body, headers);
    },
    get(path, headers = {}) {
      return invoke(app, 'GET', path, null, headers);
    },
  };
}

function invoke(app, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url: path,
      headers: Object.assign({ 'content-type': 'application/json' }, headers),
      body: body === null ? undefined : body,
    };
    const res = {
      statusCode: 200,
      body: undefined,
      _headers: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      set() {
        return this;
      },
      json(obj) {
        this.body = obj;
        return this;
      },
      end() {},
    };
    res.on = () => {};
    // Capture when the handler finishes synchronously or errors.
    try {
      app.handle(req, res, (err) => {
        if (err) return reject(err);
        resolve({ status: res.statusCode, body: res.body });
      });
    } catch (err) {
      reject(err);
    }
  });
}

// Bind app.handle for readability.
const request = app => httpInvoke(app instanceof Function ? app : app.app);

test('each correct answer counts one point and exposes no correctAnswer', async () => {
  const a = makeApp();
  const created = await request(a.app).post('/api/games', {}, auth());
  assert.equal(created.status, 201);
  for (const q of created.body.questions) {
    assert.equal('correctAnswer' in q, false, 'players must never receive correctAnswer');
  }
  const id = created.body.id;
  assert.equal(id, 1);

  const r1 = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 1, answer: '3/4' }, auth());
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, { correct: true, score: 1 });

  const r2 = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 2, answer: '1/3' }, auth());
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body, { correct: true, score: 2 });

  const r3 = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 3, answer: '2/4' }, auth());
  assert.equal(r3.status, 200);

  const score = await request(a.app).get(`/api/games/${id}/score`, auth());
  assert.equal(score.status, 200);
  assert.deepEqual(score.body, { score: 3 });
});

test('an incorrect answer does not increment the score', async () => {
  const a = makeApp();
  const created = await request(a.app).post('/api/games', {}, auth());
  const id = created.body.id;

  const r = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 1, answer: '1/2' }, auth());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { correct: false, score: 0 });

  const score = await request(a.app).get(`/api/games/${id}/score`, auth());
  assert.deepEqual(score.body, { score: 0 });
});

test('repeating a question answer returns 409 and does not double-count', async () => {
  const a = makeApp();
  const created = await request(a.app).post('/api/games', { questionIds: [1] }, auth());
  const id = created.body.id;

  const first = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 1, answer: '3/4' }, auth());
  assert.equal(first.status, 200);
  assert.equal(first.body.score, 1);

  const repeat = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 1, answer: '3/4' }, auth());
  assert.equal(repeat.status, 409);

  const score = await request(a.app).get(`/api/games/${id}/score`, auth());
  assert.deepEqual(score.body, { score: 1 });
});

test('the in-memory repository deduplicates directly (transactional contract)', async () => {
  const repo = new InMemoryGameRepository();
  const game = await repo.create(1, QUESTIONS);
  const r1 = await repo.scoreAnswer(game.id, 1, '3/4', true);
  assert.deepEqual(r1, { correct: true, score: 1 });

  await assert.rejects(() => repo.scoreAnswer(game.id, 1, '3/4', true), DuplicateAnswerError);
  const g = await repo.get(game.id);
  assert.equal(g.score, 1, 'repeat answer must not increment score');
});

test('answering while paused returns 409', async () => {
  const a = makeApp();
  const created = await request(a.app).post('/api/games', {}, auth());
  const id = created.body.id;

  const pause = await request(a.app).post(`/api/games/${id}/pause`, {}, auth());
  assert.equal(pause.status, 200);
  assert.equal(pause.body.state, GAME_STATE.PAUSED);

  const answer = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 1, answer: '3/4' }, auth());
  assert.equal(answer.status, 409);

  // Resume then answer successfully.
  const resume = await request(a.app).post(`/api/games/${id}/resume`, {}, auth());
  assert.equal(resume.status, 200);
  assert.equal(resume.body.state, GAME_STATE.IN_PROGRESS);

  const ok = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 1, answer: '3/4' }, auth());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.correct, true);
});

test('other users game is denied with 403/404 (no existence leak)', async () => {
  const a = makeApp();
  const created = await request(a.app).post('/api/games', {}, auth('student-sub'));
  const id = created.body.id;

  // A different verified subject maps to a different internal owner id.
  const denies = await request(a.app).get(`/api/games/${id}`, auth('other-sub'));
  assert.equal(denies.status, 404);

  const scoreDeny = await request(a.app).get(`/api/games/${id}/score`, auth('other-sub'));
  assert.equal(scoreDeny.status, 404);

  const answerDeny = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 1, answer: '3/4' }, auth('other-sub'));
  assert.equal(answerDeny.status, 404);

  // A game that does not exist is also 404.
  const missing = await request(a.app).get('/api/games/999', auth('student-sub'));
  assert.equal(missing.status, 404);
});

test('missing credentials return 401', async () => {
  const a = makeApp();
  const created = await request(a.app).post('/api/games', {}, auth());
  const id = created.body.id;

  const noAuth = await request(a.app).get(`/api/games/${id}`);
  assert.equal(noAuth.status, 401);

  const noAuthAnswer = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 1, answer: '3/4' });
  assert.equal(noAuthAnswer.status, 401);
});

test('malformed fraction answer returns 400', async () => {
  const a = makeApp();
  const created = await request(a.app).post('/api/games', {}, auth());
  const id = created.body.id;

  const r = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 1, answer: 'not-a-fraction' }, auth());
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'malformed_fraction');
});

test('invalid payloads return 400', async () => {
  const a = makeApp();
  const created = await request(a.app).post('/api/games', {}, auth());
  const id = created.body.id;

  const missingAnswer = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 1 }, auth());
  assert.equal(missingAnswer.status, 400);

  const missingQid = await request(a.app).post(`/api/games/${id}/answers`, { answer: '3/4' }, auth());
  assert.equal(missingQid.status, 400);

  const badId = await request(a.app).get('/api/games/abc', auth());
  assert.equal(badId.status, 400);
});

test('unknown question id returns 404', async () => {
  const a = makeApp();
  const created = await request(a.app).post('/api/games', {}, auth());
  const id = created.body.id;

  const r = await request(a.app).post(`/api/games/${id}/answers`, { questionId: 99, answer: '3/4' }, auth());
  assert.equal(r.status, 404);
});

test('validateAnswer treats equivalent reduced forms as correct', () => {
  // Independent unit-level check of the scoring primitive used by the route.
  assert.equal(validateAnswer({ correctAnswer: '3/4' }, '6/8').correct, true);
  assert.equal(validateAnswer({ correctAnswer: '1' }, '1').correct, true);
  assert.equal(validateAnswer({ correctAnswer: '1/3' }, '2/6').correct, true);
  assert.equal(validateAnswer({ correctAnswer: '1/3' }, '1/2').correct, false);
});