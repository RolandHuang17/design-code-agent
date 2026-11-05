/**
 * Unit tests for game scoring invariants using the game engine's
 * submitAnswer logic backed by an in-memory fake db.
 *
 * Invariants under test:
 *  - Each correct answer to a not-yet-correctly-answered question = +1.
 *  - Re-answering a question must never increase score (idempotent).
 *  - An incorrect answer never changes score.
 *  - Score can never decrease (answering wrong after correct is a no-op).
 */
const answerMutation = require('../../../test/support/answer-db');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DB_MODULE_PATH = require.resolve('@spacefractions/shared/db');
const ENGINE_MODULE_PATH = path.join(__dirname, '..', 'src', 'game-engine.js');

function buildEngine() {
  const store = {
    games: [],
    questions: [],
    answers: []
  };

  const questions = [
    { id: 1, prompt: 'q1', options: ['1/2', '1/3'], correct_answer: '1/2' },
    { id: 2, prompt: 'q2', options: ['3/4', '1/4'], correct_answer: '3/4' },
    { id: 3, prompt: 'q3', options: ['2/3', '1/2'], correct_answer: '2/3' }
  ];
  store.questions = questions;

  store.games.push({
    id: 1,
    user_id: 'user-1',
    state: 'playing',
    score: 0,
    question_ids: [1, 2, 3],
    current_question_index: 0
  });

  function findGame(id) { return store.games.find(g => g.id === id); }

  async function handleQuery(sql, params) {
    const s = sql.trim();
    const mutation = answerMutation(store, s, params);
    if (mutation) return mutation;
    if (/SELECT \* FROM games WHERE id = \$1(?:\s+FOR UPDATE)?\s*$/.test(s)) {
      return { rows: store.games.filter(g => g.id === params[0]) };
    }
    if (/SELECT id, correct_answer FROM questions WHERE id = \$1/.test(s)) {
      return { rows: store.questions.filter(q => q.id === params[0]).map(q => ({ id: q.id, correct_answer: q.correct_answer })) };
    }
    if (/SELECT \* FROM game_answers WHERE game_id = \$1 AND question_id = \$2/.test(s)) {
      return { rows: store.answers.filter(a => a.game_id === params[0] && a.question_id === params[1]) };
    }
    if (/SELECT scored FROM game_answers WHERE game_id = \$1 AND question_id = \$2/.test(s)) {
      return { rows: store.answers.filter(a => a.game_id === params[0] && a.question_id === params[1]).map(a => ({ scored: a.scored })) };
    }

    if (/UPDATE games SET score = score \+ 1,\s*updated_at = NOW\(\)\s*WHERE id = \$1 RETURNING score/.test(s)) {
      const game = findGame(params[0]);
      if (game) game.score += 1;
      return { rows: [{ score: game.score }] };
    }
    if (/UPDATE games\s+SET current_question_index/.test(s)) {
      const game = findGame(params[1]);
      if (game) {
        game.current_question_index = params[0];
        if (params[0] >= game.question_ids.length) game.state = 'completed';
      }
      return { rows: [{ current_question_index: game.current_question_index, state: game.state }] };
    }
    throw new Error(`Unexpected SQL: ${s}`);
  }

  const fakeDb = {
    query: async (sql, params) => handleQuery(sql, params),
    queryOne: async (sql, params) => {
      const r = await handleQuery(sql, params);
      return r.rows[0] || null;
    },
    withTransaction: async (fn) => {
      // Provide a transaction client whose query/queryOne route to the same
      // in-memory store, mirroring shared/src/db.js's withTransaction shape.
      const tx = {
        query: (sql, params) => handleQuery(sql, params),
        queryOne: async (sql, params) => {
          const r = await handleQuery(sql, params);
          return r.rows[0] || null;
        }
      };
      return fn(tx);
    }
  };

  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH, filename: DB_MODULE_PATH, loaded: true, exports: fakeDb
  };
  delete require.cache[ENGINE_MODULE_PATH];
  const engine = require(ENGINE_MODULE_PATH);
  return { engine, store };
}

test('score starts at zero and increments once per distinct correct answer', async () => {
  const { engine } = buildEngine();

  // Answer q1 wrong then correct.
  let r = await engine.submitAnswer(1, 1, '1/3', 'user-1', false);
  assert.equal(r.correct, false);
  assert.equal(r.score, 0);

  r = await engine.submitAnswer(1, 1, '1/2', 'user-1', false);
  assert.equal(r.correct, true);
  assert.equal(r.score, 1);

  // Answer q2 correct.
  r = await engine.submitAnswer(1, 2, '3/4', 'user-1', false);
  assert.equal(r.correct, true);
  assert.equal(r.score, 2);

  // Answer q3 wrong.
  r = await engine.submitAnswer(1, 3, '1/2', 'user-1', false);
  assert.equal(r.correct, false);
  assert.equal(r.score, 2);
});

test('repeated correct answer to same question does not double-count', async () => {
  const { engine } = buildEngine();

  await engine.submitAnswer(1, 1, '1/2', 'user-1', false);
  let r = await engine.submitAnswer(1, 1, '1/2', 'user-1', false);
  assert.equal(r.score, 1);
});

test('score never decreases when a previously-correct question is re-answered wrong', async () => {
  const { engine } = buildEngine();

  await engine.submitAnswer(1, 1, '1/2', 'user-1', false);
  // The answer row is already scored=true. Re-answering wrong must not change score.
  const r = await engine.submitAnswer(1, 1, '1/3', 'user-1', false);
  assert.equal(r.correct, false);
  assert.equal(r.score, 1);
});

test('score caps at number of distinct questions', async () => {
  const { engine } = buildEngine();

  await engine.submitAnswer(1, 1, '1/2', 'user-1', false);
  await engine.submitAnswer(1, 2, '3/4', 'user-1', false);
  await engine.submitAnswer(1, 3, '2/3', 'user-1', false);
  await assert.rejects(engine.submitAnswer(1, 1, '1/2', 'user-1', false), { statusCode: 409 });
  assert.equal((await engine.getScore(1)).score, 3);
});

test('full correct run yields max score and completed state', async () => {
  const { engine } = buildEngine();

  await engine.submitAnswer(1, 1, '1/2', 'user-1', false);
  await engine.submitAnswer(1, 2, '3/4', 'user-1', false);
  const r = await engine.submitAnswer(1, 3, '2/3', 'user-1', false);
  assert.equal(r.score, 3);
  assert.equal(r.gameState, 'completed');
});