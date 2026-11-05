/**
 * Unit tests for game engine pause/resume state machine and idempotency.
 *
 * The game engine depends on `@spacefractions/shared/db` (PostgreSQL). These
 * unit tests inject a fake db module into the require cache so that the pure
 * state-transition and scoring logic can be tested without a live database.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DB_MODULE_PATH = require.resolve('@spacefractions/shared/db');
const FRACTION_MODULE_PATH = require.resolve('@spacefractions/shared/fraction');
const ERRORS_MODULE_PATH = require.resolve('@spacefractions/shared/errors');
const ENGINE_MODULE_PATH = path.join(__dirname, '..', 'src', 'game-engine.js');

// Resolve the real fraction/errors modules (these are pure and safe to reuse).
const realFraction = require(FRACTION_MODULE_PATH);
const realErrors = require(ERRORS_MODULE_PATH);

/**
 * Install a fake `@spacefractions/shared/db` module backed by an in-memory
 * row store, then (re)load the game engine so its destructured imports bind
 * to the fake. Returns { engine, store }.
 *
 * The store is a small object with seeded games/questions and a query/queryOne
 * implementation that only handles the specific SQL patterns the engine uses.
 */
function buildEngine(seed) {
  const store = {
    games: [],
    questions: [],
    answers: [],
    ...(seed || {})
  };

  // A generic implementation that maps SQL text to behaviors. We only need to
  // support the statements the engine issues; anything else throws.
  function handleQuery(sql, params) {
    const s = sql.trim();

    // SELECT a single game by id (optionally with FOR UPDATE lock)
    if (/SELECT \* FROM games WHERE id = \$1( FOR UPDATE)?$/.test(s)) {
      return { rows: store.games.filter(g => g.id === params[0]) };
    }
    if (/SELECT id, score, state FROM games WHERE id = \$1/.test(s)) {
      return { rows: store.games.filter(g => g.id === params[0]).map(g => ({ id: g.id, score: g.score, state: g.state })) };
    }
    if (/SELECT id FROM questions ORDER BY created_at/.test(s)) {
      return { rows: store.questions.map(q => ({ id: q.id })) };
    }
    if (/SELECT id, prompt, options FROM questions WHERE id = \$1/.test(s)) {
      return { rows: store.questions.filter(q => q.id === params[0]) };
    }
    if (/SELECT id, correct_answer FROM questions WHERE id = \$1/.test(s)) {
      return { rows: store.questions.filter(q => q.id === params[0]).map(q => ({ id: q.id, correct_answer: q.correct_answer })) };
    }
    if (/SELECT \* FROM game_answers WHERE game_id = \$1 AND question_id = \$2/.test(s)) {
      return { rows: store.answers.filter(a => a.game_id === params[0] && a.question_id === params[1]) };
    }

    // INSERT INTO games ... RETURNING *
    if (/INSERT INTO games /.test(s)) {
      const id = store.games.length + 1;
      const game = {
        id,
        user_id: params[0],
        state: 'playing',
        score: 0,
        question_ids: params[1],
        current_question_index: 0
      };
      store.games.push(game);
      return { rows: [game] };
    }

    // UPDATE games SET state = 'paused' ... RETURNING *
    if (/UPDATE games SET state = 'paused'/.test(s)) {
      const game = store.games.find(g => g.id === params[0]);
      if (game && game.state === 'playing') {
        game.state = 'paused';
        return { rows: [game] };
      }
      return { rows: [] };
    }

    // UPDATE games SET state = 'playing' ... RETURNING *
    if (/UPDATE games SET state = 'playing'/.test(s)) {
      const game = store.games.find(g => g.id === params[0]);
      if (game && game.state === 'paused') {
        game.state = 'playing';
        return { rows: [game] };
      }
      return { rows: [] };
    }

    // UPDATE games SET score = score + 1 ... RETURNING score
    if (/UPDATE games SET score = score \+ 1/.test(s)) {
      const game = store.games.find(g => g.id === params[0]);
      if (game) game.score = (game.score || 0) + 1;
      return { rows: [{ score: game ? game.score : 0 }] };
    }

    // UPDATE games SET current_question_index = $1, state = CASE ... WHERE id = $2
    if (/UPDATE games\s+SET current_question_index = \$1/.test(s)) {
      const newIndex = params[0];
      const game = store.games.find(g => g.id === params[1]);
      if (game) {
        game.current_question_index = newIndex;
        if (newIndex >= game.question_ids.length) game.state = 'completed';
      }
      return { rows: [{ current_question_index: game.current_question_index, state: game.state }] };
    }

    // Consolidated data-modifying CTE issued by submitAnswer(): upsert the
    // answer row and compute `newly_scored`, then update game score/index/state
    // in one statement so the returned row has score + state (avoids NaN).
    if (/WITH answer_upsert AS/.test(s)) {
      const [gameId, questionId, answer, correct] = params;
      const game = store.games.find(g => g.id === gameId);

      let existing = store.answers.find((a) => a.game_id === gameId && a.question_id === questionId);
      let newlyScored;
      if (existing) {
        newlyScored = existing.scored === false && correct === true;
        existing.answer = answer;
        existing.correct = correct;
        if (newlyScored) existing.scored = true;
      } else {
        newlyScored = correct === true;
        const id = store.answers.length + 1;
        const row = { id, game_id: gameId, question_id: questionId, answer, correct, scored: correct };
        store.answers.push(row);
      }

      const qIds = game.question_ids;
      const curIdx = game.current_question_index;
      const isCurrent = qIds[curIdx] === questionId;
      if (newlyScored) game.score = (game.score || 0) + 1;
      if (isCurrent) {
        game.current_question_index = curIdx + 1;
        if (curIdx + 1 >= qIds.length) game.state = 'completed';
      }

      return {
        rows: [{ newly_scored: newlyScored, correct, score: game.score, state: game.state }]
      };
    }

    // UPDATE game_answers SET ...
    if (/UPDATE game_answers SET/.test(s)) {
      const [answer, correctStr, scoredStr, id] = params;
      const row = store.answers.find(a => a.id === id);
      if (row) {
        row.answer = answer;
        row.correct = correctStr;
        row.scored = scoredStr;
      }
      return { rows: [row] };
    }

    // SELECT * FROM games WHERE id = $1 (getScore final fetch) - already handled
    throw new Error(`Unexpected SQL in test fake db: ${s}`);
  }

  const fakeDb = {
    query: async (sql, params) => handleQuery(sql, params),
    queryOne: async (sql, params) => {
      const result = await handleQuery(sql, params);
      return result.rows[0] || null;
    },
    // The engine calls withTransaction; emulate the same tx interface over the
    // in-memory store (no real BEGIN/COMMIT needed for unit tests).
    withTransaction: async (fn) => {
      const tx = {
        query: (sql, params) => handleQuery(sql, params),
        queryOne: async (sql, params) => {
          const result = await handleQuery(sql, params);
          return result.rows[0] || null;
        }
      };
      return fn(tx);
    }
  };

  // Inject the fake db, but keep real fraction/errors referenceable.
  require.cache[DB_MODULE_PATH] = {
    id: DB_MODULE_PATH,
    filename: DB_MODULE_PATH,
    loaded: true,
    exports: fakeDb
  };

  // Ensure a clean reload of the engine module each time.
  delete require.cache[ENGINE_MODULE_PATH];
  const engine = require(ENGINE_MODULE_PATH);

  return { engine, store };
}

test('createGame with explicit question ids', async () => {
  const { engine, store } = buildEngine({
    questions: [{ id: 1, correct_answer: '1/2' }]
  });
  const game = await engine.createGame('user-1', [1]);
  assert.equal(game.user_id, 'user-1');
  assert.deepEqual(game.question_ids, [1]);
  assert.equal(game.state, 'playing');
  assert.equal(game.score, 0);
});

test('createGame fetches all questions when none provided', async () => {
  const { engine, store } = buildEngine({
    questions: [{ id: 1 }, { id: 2 }, { id: 3 }]
  });
  const game = await engine.createGame('user-1', []);
  assert.deepEqual(game.question_ids, [1, 2, 3]);
});

test('createGame throws when no questions available', async () => {
  const { engine } = buildEngine({ questions: [] });
  await assert.rejects(
    () => engine.createGame('user-1', []),
    (err) => err instanceof realErrors.BadRequestError
  );
});

test('getGame authorizes owner', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'user-1', state: 'playing', score: 0, question_ids: [1], current_question_index: 0 }]
  });
  const game = await engine.getGame(1, 'user-1', false);
  assert.equal(game.id, 1);
});

test('getGame denies non-owner (returns NotFound)', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'user-1', state: 'playing', score: 0, question_ids: [1], current_question_index: 0 }]
  });
  await assert.rejects(
    () => engine.getGame(1, 'user-2', false),
    (err) => err instanceof realErrors.NotFoundError
  );
});

test('getGame allows admin to access any game', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'user-1', state: 'playing', score: 0, question_ids: [1], current_question_index: 0 }]
  });
  const game = await engine.getGame(1, 'admin', true);
  assert.equal(game.id, 1);
});

test('getGame NotFound for missing game', async () => {
  const { engine } = buildEngine({ games: [] });
  await assert.rejects(
    () => engine.getGame(999, 'user-1', false),
    (err) => err instanceof realErrors.NotFoundError
  );
});

test('pauseGame transitions playing -> paused', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'playing', score: 0, question_ids: [1], current_question_index: 0 }]
  });
  const game = await engine.pauseGame(1);
  assert.equal(game.state, 'paused');
});

test('pauseGame is idempotent when already paused', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'paused', score: 0, question_ids: [1], current_question_index: 0 }]
  });
  const game = await engine.pauseGame(1);
  assert.equal(game.state, 'paused');
});

test('pauseGame throws ConflictError when completed', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'completed', score: 1, question_ids: [1], current_question_index: 1 }]
  });
  await assert.rejects(
    () => engine.pauseGame(1),
    (err) => err instanceof realErrors.ConflictError
  );
});

test('resumeGame transitions paused -> playing', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'paused', score: 0, question_ids: [1], current_question_index: 0 }]
  });
  const game = await engine.resumeGame(1);
  assert.equal(game.state, 'playing');
});

test('resumeGame is idempotent when already playing', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'playing', score: 0, question_ids: [1], current_question_index: 0 }]
  });
  const game = await engine.resumeGame(1);
  assert.equal(game.state, 'playing');
});

test('resumeGame throws ConflictError when completed', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'completed', score: 1, question_ids: [1], current_question_index: 1 }]
  });
  await assert.rejects(
    () => engine.resumeGame(1),
    (err) => err instanceof realErrors.ConflictError
  );
});

test('getCurrentQuestion returns null when completed', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'completed', score: 1, question_ids: [1], current_question_index: 1 }],
    questions: [{ id: 1, prompt: 'q', options: ['1/2', '1/3'] }]
  });
  const q = await engine.getCurrentQuestion(1);
  assert.equal(q, null);
});

test('getCurrentQuestion returns the question at the current index', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'playing', score: 0, question_ids: [9], current_question_index: 0 }],
    questions: [{ id: 9, prompt: 'what?', options: ['1/2', '1/3'] }]
  });
  const q = await engine.getCurrentQuestion(1);
  assert.equal(q.id, 9);
  assert.equal(q.prompt, 'what?');
});

test('submitAnswer rejects answer while paused', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'paused', score: 0, question_ids: [1], current_question_index: 0 }],
    questions: [{ id: 1, correct_answer: '1/2' }]
  });
  await assert.rejects(
    () => engine.submitAnswer(1, 1, '1/2', 'u', false),
    (err) => err instanceof realErrors.ConflictError && /paused/i.test(err.message)
  );
});

test('submitAnswer rejects malformed fraction', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'playing', score: 0, question_ids: [1], current_question_index: 0 }],
    questions: [{ id: 1, correct_answer: '1/2' }]
  });
  await assert.rejects(
    () => engine.submitAnswer(1, 1, 'not-a-fraction', 'u', false),
    (err) => err instanceof realErrors.BadRequestError && /malformed/i.test(err.message)
  );
});

test('submitAnswer rejects question not in game', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'playing', score: 0, question_ids: [1], current_question_index: 0 }],
    questions: [{ id: 1, correct_answer: '1/2' }, { id: 2, correct_answer: '1/3' }]
  });
  await assert.rejects(
    () => engine.submitAnswer(1, 2, '1/3', 'u', false),
    (err) => err instanceof realErrors.BadRequestError && /part of this game/i.test(err.message)
  );
});

test('submitAnswer correct answer scores 1 and transitions to completed', async () => {
  const { engine, store } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'playing', score: 0, question_ids: [1], current_question_index: 0 }],
    questions: [{ id: 1, correct_answer: '1/2' }]
  });
  const result = await engine.submitAnswer(1, 1, '2/4', 'u', false);
  assert.equal(result.correct, true);
  assert.equal(result.score, 1);
  assert.equal(result.gameState, 'completed');
});

test('submitAnswer wrong answer does not increase score', async () => {
  const { engine, store } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'playing', score: 0, question_ids: [1], current_question_index: 0 }],
    questions: [{ id: 1, correct_answer: '1/2' }]
  });
  const result = await engine.submitAnswer(1, 1, '1/3', 'u', false);
  assert.equal(result.correct, false);
  assert.equal(result.score, 0);
});

test('re-answering a question correctly is idempotent (no double score)', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'playing', score: 1, question_ids: [1], current_question_index: 1 }],
    questions: [{ id: 1, correct_answer: '1/2' }],
    answers: [{ id: 1, game_id: 1, question_id: 1, answer: '1/2', correct: true, scored: true }]
  });

  // The game is effectively completed (index advanced beyond last question),
  // but for idempotency testing we construct a two-question game.
  const { engine: engine2, store: store2 } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'playing', score: 1, question_ids: [1, 2], current_question_index: 1 }],
    questions: [
      { id: 1, correct_answer: '1/2' },
      { id: 2, correct_answer: '3/4' }
    ],
    answers: [{ id: 1, game_id: 1, question_id: 1, answer: '1/2', correct: true, scored: true }]
  });

  // Re-answer question 1 (already scored). Should not increase score.
  const result = await engine2.submitAnswer(1, 1, '1/2', 'u', false);
  assert.equal(result.correct, true);
  assert.equal(result.score, 1); // unchanged
});

test('getScore returns score and state', async () => {
  const { engine } = buildEngine({
    games: [{ id: 1, user_id: 'u', state: 'playing', score: 3, question_ids: [1], current_question_index: 0 }]
  });
  const result = await engine.getScore(1);
  assert.equal(result.score, 3);
  assert.equal(result.state, 'playing');
});

test('getScore NotFound for missing game', async () => {
  const { engine } = buildEngine({ games: [] });
  await assert.rejects(
    () => engine.getScore(999),
    (err) => err instanceof realErrors.NotFoundError
  );
});