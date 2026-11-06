'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { GameError, createGameService, validateAnswerText } = require('../services/game-service');
const { States } = require('../lib/game-state');
const { parseFraction, equals } = require('../lib/fraction');

/**
 * In-memory fake of the lib/db.js persistence contract, exercised through the
 * real game service boundary so unit tests assert the service's behavior
 * WITHOUT any live PostgreSQL/Redis/RabbitMQ. The fake implements the same
 * shapes and error types (`DbError` with `.status`) that the service maps.
 *
 * The `pool` object passed to `createGameService` here is the fake store itself;
 * the service only calls the db functions with `pool` as the first argument, and
 * we stub those functions below by monkey-patching `lib/db` exports so the real
 * game service module picks them up. This keeps tests honest about the service
 * layer while remaining fully deterministic and offline.
 */

const { DbError } = require('../lib/db');

function makeStore() {
  const data = {
    games: new Map(), // id -> { game_state }
    owners: new Map(), // gameId -> ownerUserId
    questions: new Map(), // id -> { prompt, options, correct_answer }
    answers: new Map(), // `${gameId}:${questionId}` -> { answer, correct }
    gameQuestions: new Map(), // gameId -> [{id,prompt,options}] in position order
    seq: 0,
  };
  return data;
}

function stateOf(store, gameId) {
  const raw = store.games.get(gameId).game_state;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function setState(store, gameId, state) {
  store.games.set(gameId, { game_state: JSON.stringify(state) });
}

function scoreOf(store, gameId) {
  const s = stateOf(store, gameId);
  return typeof s.score === 'number' ? s.score : 0;
}

/** Build a fake `pool` whose db calls are implemented in-memory. */
function makePool(store) {
  return { __store: store };
}

// The db functions are called as `fn(pool, ...)`. We wrap real db functions'
// logic against the fake store by re-implementing the minimal needed behavior,
// but we must reach into the SERVICE's require. Instead, we inject by using a
// require cache shim: the service imported `submitAnswer` etc. at module load.
// To keep the test truly exercising the service, we construct the service with a
// `pool` and a stub-only approach is not possible without monkey-patching.
//
// The cleanest offline strategy: provide a fake pool implementing the *pg pool*
// surface (connect -> transaction client) so lib/db.js itself runs against the
// fake. This exercises the real db + service layers end-to-end in-memory.

class FakeClient {
  constructor(store) {
    this.store = store;
    this.inTx = false;
  }
  async query(sql, params = []) {
    return runSql(this.store, sql, params);
  }
  async release() {}
}

function makePgPool(store) {
  return {
    async connect() {
      return new FakeClient(store);
    },
    async query(sql, params = []) {
      return runSql(store, sql, params);
    },
  };
}

/**
 * Minimal SQL interpreter for the exact statements the db layer issues against
 * the fake store. This keeps everything in-memory while exercising the real
 * lib/db.js transaction functions and the real game service mapping.
 */
function runSql(store, sql, params) {
  const s = sql.replace(/\s+/g, ' ').trim();

  // BEGIN / COMMIT / ROLLBACK
  if (/^BEGIN/i.test(s)) return { rows: [] };
  if (/^COMMIT/i.test(s)) return { rows: [] };
  if (/^ROLLBACK/i.test(s)) return { rows: [] };

  // users upsert (not used by game service tests, satisfy no-op)
  if (/INSERT INTO users/.test(s)) {
    return { rows: [{ id: 1 }] };
  }

  // createGame: INSERT INTO games ... RETURNING id
  if (/INSERT INTO games \(game_state\)/.test(s)) {
    store.seq += 1;
    const id = store.seq;
    store.games.set(id, { game_state: params[0] });
    return { rows: [{ id }] };
  }

  // INSERT INTO games_owners
  if (/INSERT INTO games_owners/.test(s)) {
    const gameId = params[0];
    const owner = params[1];
    store.owners.set(gameId, owner);
    return { rows: [] };
  }

  // INSERT INTO game_questions
  if (/INSERT INTO game_questions/.test(s)) {
    const gameId = params[0];
    const qid = params[1];
    const pos = params[2];
    if (!store.gameQuestions.has(gameId)) store.gameQuestions.set(gameId, []);
    const q = store.questions.get(qid);
    store.gameQuestions.get(gameId)[pos] = { id: qid, prompt: q.prompt, options: q.options };
    return { rows: [] };
  }

  // questions SELECT
  if (/SELECT id, prompt, options FROM questions/.test(s)) {
    if (/ANY\(\$1::int\[\]\)/.test(s)) {
      const ids = params[0];
      const rows = ids.map((id) => {
        const q = store.questions.get(id);
        return q ? { id, prompt: q.prompt, options: q.options } : null;
      }).filter(Boolean);
      return { rows };
    }
    // seeded set in id order
    const rows = [...store.questions.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, q]) => ({ id, prompt: q.prompt, options: q.options }));
    return { rows };
  }

  // getGame: SELECT g.id, g.game_state, o.owner_user_id FROM games g LEFT JOIN ...
  if (/FROM games g\s+LEFT JOIN games_owners o/.test(s)) {
    const gameId = params[0];
    const game = store.games.get(gameId);
    if (!game) return { rows: [] };
    return {
      rows: [{ id: gameId, game_state: game.game_state, owner_user_id: store.owners.get(gameId) }],
    };
  }

  // submitAnswer: SELECT game_state FROM games WHERE id = $1 FOR UPDATE
  if (/SELECT game_state FROM games WHERE id = \$1 FOR UPDATE/.test(s)) {
    const gameId = params[0];
    const game = store.games.get(gameId);
    return game ? { rows: [{ game_state: game.game_state }] } : { rows: [] };
  }

  // SELECT owner_user_id FROM games_owners WHERE game_id = $1
  if (/SELECT owner_user_id FROM games_owners WHERE game_id = \$1/.test(s)) {
    const gameId = params[0];
    const owner = store.owners.get(gameId);
    return owner === undefined ? { rows: [] } : { rows: [{ owner_user_id: owner }] };
  }

  // transitionGame: SELECT game_state FROM games WHERE id = $1 FOR UPDATE (already handled)
  // answer: SELECT correct_answer FROM questions WHERE id = $1
  if (/SELECT correct_answer FROM questions WHERE id = \$1/.test(s)) {
    const q = store.questions.get(params[0]);
    return q ? { rows: [{ correct_answer: q.correct_answer }] } : { rows: [] };
  }

  // SELECT correct FROM answers WHERE game_id = $1 AND question_id = $2
  if (/SELECT correct FROM answers WHERE game_id = \$1 AND question_id = \$2/.test(s)) {
    const key = `${params[0]}:${params[1]}`;
    return store.answers.has(key)
      ? { rows: [{ correct: store.answers.get(key).correct }] }
      : { rows: [] };
  }

  // INSERT INTO answers
  if (/INSERT INTO answers \(game_id, question_id, answer, correct\)/.test(s)) {
    const key = `${params[0]}:${params[1]}`;
    store.answers.set(key, { answer: params[2], correct: params[3] });
    return { rows: [] };
  }

  // UPDATE games SET game_state = $1 WHERE id = $2
  if (/UPDATE games SET game_state = \$1 WHERE id = \$2/.test(s)) {
    store.games.set(params[1], { game_state: params[0] });
    return { rows: [] };
  }

  // computeScore / getScore: SELECT COUNT(*) ... FROM answers WHERE game_id = $1 AND correct = true
  if (/SELECT COUNT\(\*\)::int AS (correct_count|score) FROM answers/.test(s)) {
    const gameId = params[0];
    let count = 0;
    for (const [key, val] of store.answers.entries()) {
      const [gid] = key.split(':').map(Number);
      if (gid === gameId && val.correct) count += 1;
    }
    const col = /AS correct_count/.test(s) ? 'correct_count' : 'score';
    return { rows: [{ [col]: count }] };
  }

  throw new Error(`Unexpected SQL in fake: ${sql}`);
}

function seedQuestion(store, id, prompt, options, correctAnswer) {
  store.questions.set(id, { prompt, options, correct_answer: correctAnswer });
}

function setup() {
  const store = makeStore();
  seedQuestion(store, 1, '1/2 + 1/4 = ?', ['1/4', '3/4', '1/2'], '3/4');
  seedQuestion(store, 2, '2/3 of 6 = ?', ['3', '4', '5'], '4');
  const pool = makePgPool(store);
  return { store, pool };
}

test('newGame returns 201-shaped {id, questions} without correctAnswer', async () => {
  const { pool } = setup();
  const service = createGameService(pool);
  const result = await service.newGame(7, [1, 2]);
  assert.ok(Number.isInteger(result.id));
  assert.strictEqual(result.questions.length, 2);
  for (const q of result.questions) {
    assert.ok(q.id !== undefined);
    assert.ok(typeof q.prompt === 'string');
    assert.ok(Array.isArray(q.options));
    assert.strictEqual(q.correctAnswer, undefined);
  }
});

test('answer submits a correct answer and increments score by 1', async () => {
  const { pool } = setup();
  const service = createGameService(pool);
  const game = await service.newGame(7, [1]);
  const result = await service.answer(game.id, 1, '3/4', 7);
  assert.strictEqual(result.correct, true);
  assert.strictEqual(result.score, 1);
});

test('answer marks an incorrect answer without increasing score', async () => {
  const { pool } = setup();
  const service = createGameService(pool);
  const game = await service.newGame(7, [1]);
  const result = await service.answer(game.id, 1, '1/4', 7);
  assert.strictEqual(result.correct, false);
  assert.strictEqual(result.score, 0);
});

test('repeating a question does not increase the score (idempotent)', async () => {
  const { pool } = setup();
  const service = createGameService(pool);
  const game = await service.newGame(7, [1]);
  await service.answer(game.id, 1, '3/4', 7);
  const second = await service.answer(game.id, 1, '3/4', 7);
  assert.strictEqual(second.correct, true);
  assert.strictEqual(second.score, 1);

  const wrong = await service.answer(game.id, 1, '1/4', 7);
  // The stored "correct" result is preserved on a repeated answer.
  assert.strictEqual(wrong.correct, true);
  assert.strictEqual(wrong.score, 1);
});

test('pause then resume transitions state; answering while paused is a 409', async () => {
  const { pool } = setup();
  const service = createGameService(pool);
  const game = await service.newGame(7, [1]);

  const paused = await service.pauseGame(game.id, 7);
  assert.strictEqual(paused.state, States.PAUSED);

  await assert.rejects(
    () => service.answer(game.id, 1, '3/4', 7),
    (err) => err instanceof GameError && err.status === 409
  );

  const resumed = await service.resumeGame(game.id, 7);
  assert.strictEqual(resumed.state, States.PLAYING);

  const result = await service.answer(game.id, 1, '3/4', 7);
  assert.strictEqual(result.score, 1);
});

test('pause/resume/answer enforce owner authorization (403 for other users)', async () => {
  const { pool } = setup();
  const service = createGameService(pool);
  const game = await service.newGame(7, [1]);

  // pause as other user
  await assert.rejects(
    () => service.pauseGame(game.id, 99),
    (err) => err instanceof GameError && err.status === 403
  );

  // resume as other user
  await assert.rejects(
    () => service.resumeGame(game.id, 99),
    (err) => err instanceof GameError && err.status === 403
  );

  // answer as other user
  await assert.rejects(
    () => service.answer(game.id, 1, '3/4', 99),
    (err) => err instanceof GameError && err.status === 403
  );

  // score as other user
  await assert.rejects(
    () => service.viewScore(game.id, 99),
    (err) => err instanceof GameError && err.status === 403
  );

  // view game as other user
  await assert.rejects(
    () => service.viewGame(game.id, 99),
    (err) => err instanceof GameError && err.status === 403
  );
});

test('accessing a non-existent game returns 404', async () => {
  const { pool } = setup();
  const service = createGameService(pool);
  await assert.rejects(
    () => service.viewGame(9999, 7),
    (err) => err instanceof GameError && err.status === 404
  );
  await assert.rejects(
    () => service.answer(9999, 1, '3/4', 7),
    (err) => err instanceof GameError && err.status === 404
  );
});

test('malformed fraction answer is rejected as 400', async () => {
  const { pool } = setup();
  const service = createGameService(pool);
  const game = await service.newGame(7, [1]);
  await assert.rejects(
    () => service.answer(game.id, 1, 'not-a-fraction', 7),
    (err) => err instanceof GameError && err.status === 400
  );
  await assert.rejects(
    () => service.answer(game.id, 1, '1/0', 7),
    (err) => err instanceof GameError && err.status === 400
  );
});

test('validateAnswerText accepts valid fractions and rejects malformed ones', () => {
  assert.strictEqual(validateAnswerText('1/2'), true);
  assert.strictEqual(validateAnswerText('2/4'), true);
  assert.throws(
    () => validateAnswerText('garbage'),
    (err) => err instanceof GameError && err.status === 400
  );
});

test('score view returns the accumulated score for the owner', async () => {
  const { pool } = setup();
  const service = createGameService(pool);
  const game = await service.newGame(7, [1, 2]);
  await service.answer(game.id, 1, '3/4', 7);
  await service.answer(game.id, 2, '4', 7);
  const result = await service.viewScore(game.id, 7);
  assert.strictEqual(result.score, 2);
});

test('viewGame exposes player-safe state and never leaks correctAnswer', async () => {
  const { pool } = setup();
  const service = createGameService(pool);
  const game = await service.newGame(7, [1]);
  const state = await service.viewGame(game.id, 7);
  assert.strictEqual(state.id, game.id);
  assert.strictEqual(state.state, States.PLAYING);
  assert.strictEqual(state.score, 0);
  assert.ok(Array.isArray(state.questions));
  for (const q of state.questions) {
    assert.strictEqual(q.correctAnswer, undefined);
    assert.strictEqual('correctAnswer' in q, false);
  }
  // The JSON serialization must also be free of any answer key.
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('correct_answer'));
  assert.ok(!serialized.includes('correctAnswer'));
});

test('fraction equality is exercised end-to-end via the real fraction module', () => {
  // Guard that the service's exact-rational comparison uses canonical reduction.
  assert.deepStrictEqual(parseFraction('2/4'), parseFraction('1/2'));
  assert.strictEqual(equals(parseFraction('2/4'), parseFraction('1/2')), true);
});