'use strict';

/**
 * Persistence layer for Space Fractions.
 *
 * Owns the connection pool, migration/seed application, and the transactional
 * operations required by the acceptance contract (space-fractions.md 41-49):
 *
 *   * PostgreSQL is the system of record for all game state.
 *   * A verified OIDC subject string maps to a numeric internal user id via an
 *     idempotent, concurrency-safe upsert.
 *   * Score updates serialize per game and deduplicate repeated question answers
 *     within the same transaction.
 *   * A single owned transaction client is used per operation and rolled back on
 *     any error.
 *
 * PG16 constraint: we never use EXCLUDED inside a RETURNING clause (illegal on
 * PG16). Every upsert uses a simple `INSERT ... ON CONFLICT (...) DO UPDATE ...
 * RETURNING` statement instead of elaborate CTEs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { parseFraction, equals } = require('./fraction');
const { States, initialState } = require('./game-state');

const SQL_DIR = path.join(__dirname, '..', 'sql');
const MIGRATION_DIR = path.join(SQL_DIR, 'migrations');

/**
 * Minimal error type for persistence-layer failures so callers can map them to
 * HTTP statuses without coupling to pg error codes.
 */
class DbError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DbError';
    this.code = code || 'DB_ERROR';
  }
}

/**
 * Build a Pool from a config object (or a pg ConnectionConfig string).
 * Accepts a config with a `connectionString` or individual host/db/user keys.
 */
function createPool(config) {
  if (typeof config === 'string') {
    return new Pool({ connectionString: config });
  }
  if (config && typeof config === 'object') {
    return new Pool(config);
  }
  return new Pool();
}

/**
 * Apply the canonical migration (sql/migrations/001_init.sql) idempotently.
 * The migration itself uses `\i ../game_ddl.sql` plus seed inserts with
 * ON CONFLICT DO NOTHING, so running it more than once is a no-op. Because the
 * `\i` psql meta-command is not valid inside a single pg query, we execute the
 * files in dependency order here: game_ddl.sql first, then the seed body of
 * 001_init.sql.
 *
 * Returns the list of files applied.
 */
async function migrate(poolOrClient) {
  const client =
    typeof poolOrClient.query === 'function' && typeof poolOrClient.connect === 'function'
      ? await poolOrClient.connect()
      : poolOrClient;
  const owned = client !== poolOrClient;

  let ddl;
  let migration;
  try {
    ddl = fs.readFileSync(path.join(SQL_DIR, 'game_ddl.sql'), 'utf8');
    migration = fs.readFileSync(path.join(MIGRATION_DIR, '001_init.sql'), 'utf8');
  } catch (err) {
    if (owned) client.release();
    throw new DbError(`Failed to read SQL migration files: ${err.message}`, 'MIGRATION_READ_ERROR');
  }

  const applied = [];
  try {
    await client.query(ddl);
    applied.push('game_ddl.sql');

    // Strip the psql `\i` include line; the schema has already been applied above.
    const seedBody = migration
      .split(/\r?\n/)
      .filter((line) => !/^\\i\s/.test(line.trim()))
      .join('\n');

    await client.query(seedBody);
    applied.push('001_init.sql');
  } catch (err) {
    throw new DbError(`Migration failed: ${err.message}`, 'MIGRATION_ERROR');
  } finally {
    if (owned) client.release();
  }

  return applied;
}

/**
 * Upsert a verified OIDC subject and return its numeric internal user id.
 * Because users.sub is UNIQUE, concurrent calls for the same subject converge
 * to the same row id deterministically (no races, no duplicates).
 */
async function upsertUser(client, sub, displayName = '') {
  const result = await client.query(
    `INSERT INTO users (sub, display_name)
     VALUES ($1, $2)
     ON CONFLICT (sub) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [sub, displayName]
  );
  return result.rows[0].id;
}

/**
 * Run `fn` inside a single owned transaction client. `fn(client)` receives the
 * transaction client and its return value is committed. On any error, the
 * transaction is rolled back and the client released before the error propagates.
 */
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackErr) {
      /* best-effort rollback only */
    }
    throw err;
  } finally {
    client.release();
    released = true;
    void released;
  }
}

/**
 * Create a new game owned by `ownerUserId`. `questionIds` is an optional array;
 * when empty/undefined, draw from the seeded question bank in deterministic id
 * order. Persists the game row (game_state JSONB seeded with the Playing state)
 * and the stable, position-ordered question set in one transaction.
 *
 * Returns { id, questions } where questions is [{ id, prompt, options }] with no
 * correctAnswer (contract: never leak answers to players).
 */
async function createGame(pool, ownerUserId, questionIds) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO games (game_state) VALUES ($1) RETURNING id`,
      [JSON.stringify(initialState())]
    );
    const gameId = rows[0].id;

    await client.query(
      `INSERT INTO games_owners (game_id, owner_user_id) VALUES ($1, $2)`,
      [gameId, ownerUserId]
    );

    // Select the question set: explicit ids if provided, otherwise the seeded set.
    let questionRows;
    if (Array.isArray(questionIds) && questionIds.length > 0) {
      questionRows = await client.query(
        `SELECT id, prompt, options FROM questions WHERE id = ANY($1::int[]) ORDER BY id`,
        [questionIds]
      );
    } else {
      questionRows = await client.query(
        `SELECT id, prompt, options FROM questions ORDER BY id`
      );
    }

    const ordered = questionRows.rows;
    for (let i = 0; i < ordered.length; i += 1) {
      await client.query(
        `INSERT INTO game_questions (game_id, question_id, position) VALUES ($1, $2, $3)`,
        [gameId, ordered[i].id, i]
      );
    }

    return {
      id: gameId,
      questions: ordered.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        options: q.options,
      })),
    };
  });
}

/**
 * Load a game's persisted state (id, owner sub mapping, state, score) without
 * leaking answer keys. Returns null when the game does not exist, or a sentinel
 * { exists:false, ownerUserId:null } shape so callers can distinguish 404 vs
 * 403 (other user's game).
 */
async function getGame(pool, gameId) {
  const result = await pool.query(
    `SELECT g.id, g.game_state, o.owner_user_id
       FROM games g
       LEFT JOIN games_owners o ON o.game_id = g.id
      WHERE g.id = $1`,
    [gameId]
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  const state = typeof row.game_state === 'string' ? JSON.parse(row.game_state) : row.game_state;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    state: state && state.state ? state.state : States.PLAYING,
    score: state && typeof state.score === 'number' ? state.score : 0,
  };
}

/**
 * Submit an answer for `gameId`/`questionId` within a single serialized
 * transaction. Enforces:
 *
 *   * Ownership check (other user's game -> typed 403 error).
 *   * The game must be Playing to accept an answer (paused/finished -> 409).
 *   * `answer` must parse as a single reduced fraction; malformed -> 400.
 *   * A repeated answer for the same question does NOT increase the score and
 *     returns the existing result (idempotent 200) rather than a 409.
 *
 * The per-game lock (SELECT ... FOR UPDATE) serializes concurrent score updates.
 * The unique index on answers(game_id, question_id) plus the transaction makes
 * deduplication safe.
 */
async function submitAnswer(pool, gameId, questionId, answer, ownerUserId) {
  return withTransaction(pool, async (client) => {
    // Lock the game row to serialize score updates for this game.
    const gameResult = await client.query(
      `SELECT game_state FROM games WHERE id = $1 FOR UPDATE`,
      [gameId]
    );
    if (gameResult.rows.length === 0) {
      const err = new DbError('Game not found', 'NOT_FOUND');
      err.status = 404;
      throw err;
    }

    const ownerResult = await client.query(
      `SELECT owner_user_id FROM games_owners WHERE game_id = $1`,
      [gameId]
    );
    const actualOwner = ownerResult.rows.length ? ownerResult.rows[0].owner_user_id : null;
    if (actualOwner === null || actualOwner !== ownerUserId) {
      const err = new DbError('Not authorized for this game', 'FORBIDDEN');
      err.status = 403;
      throw err;
    }

    const gameState =
      typeof gameResult.rows[0].game_state === 'string'
        ? JSON.parse(gameResult.rows[0].game_state)
        : gameResult.rows[0].game_state;
    const currentState = gameState && gameState.state ? gameState.state : States.PLAYING;
    if (currentState !== States.PLAYING) {
      const err = new DbError(`Game is not playable (${currentState})`, 'CONFLICT');
      err.status = 409;
      throw err;
    }

    // Validate the submitted answer as a single reduced fraction (server-side).
    let submitted;
    try {
      submitted = parseFraction(answer);
    } catch (fractionErr) {
      const err = new DbError(fractionErr.message, 'INVALID_FRACTION');
      err.status = 400;
      throw err;
    }

    // Fetch the question and its canonical correct answer.
    const questionResult = await client.query(
      `SELECT correct_answer FROM questions WHERE id = $1`,
      [questionId]
    );
    if (questionResult.rows.length === 0) {
      const err = new DbError('Question not found', 'NOT_FOUND');
      err.status = 404;
      throw err;
    }
    const correctAnswerText = questionResult.rows[0].correct_answer;
    let correct;
    try {
      const correctFraction = parseFraction(correctAnswerText);
      correct = equals(submitted, correctFraction);
    } catch (_e) {
      correct = false;
    }

    // Deduplicate: if this question was already answered, return the stored
    // result without changing the score.
    const existing = await client.query(
      `SELECT correct FROM answers WHERE game_id = $1 AND question_id = $2`,
      [gameId, questionId]
    );
    if (existing.rows.length > 0) {
      const wasCorrect = existing.rows[0].correct;
      const score = await computeScore(client, gameId);
      return { correct: wasCorrect, score };
    }

    // Record the answer.
    await client.query(
      `INSERT INTO answers (game_id, question_id, answer, correct)
       VALUES ($1, $2, $3, $4)`,
      [gameId, questionId, String(answer), correct]
    );

    // Increment the persisted score only when correct (each correct = 1).
    if (correct) {
      const currentScore =
        typeof gameState.score === 'number' ? gameState.score : 0;
      await client.query(
        `UPDATE games SET game_state = $1 WHERE id = $2`,
        [JSON.stringify(Object.assign({}, gameState, { score: currentScore + 1 })), gameId]
      );
    }

    const score = await computeScore(client, gameId);
    return { correct, score };
  });
}

async function computeScore(client, gameId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS correct_count
       FROM answers
      WHERE game_id = $1 AND correct = true`,
    [gameId]
  );
  return result.rows[0].correct_count;
}

/**
 * Get the current score for a game. Enforces ownership (other user -> 403).
 */
async function getScore(pool, gameId, ownerUserId) {
  const game = await getGame(pool, gameId);
  if (!game) {
    const err = new DbError('Game not found', 'NOT_FOUND');
    err.status = 404;
    throw err;
  }
  if (game.ownerUserId !== ownerUserId) {
    const err = new DbError('Not authorized for this game', 'FORBIDDEN');
    err.status = 403;
    throw err;
  }
  const result = await pool.query(
    `SELECT COUNT(*)::int AS score FROM answers WHERE game_id = $1 AND correct = true`,
    [gameId]
  );
  return result.rows[0].score;
}

/**
 * Transition a game lifecycle state (pause/resume). Returns the new state.
 * Enforces ownership; invalid transition -> 409.
 */
async function transitionGame(pool, gameId, ownerUserId, transitionFn) {
  return withTransaction(pool, async (client) => {
    const ownerResult = await client.query(
      `SELECT owner_user_id FROM games_owners WHERE game_id = $1`,
      [gameId]
    );
    if (ownerResult.rows.length === 0) {
      const err = new DbError('Game not found', 'NOT_FOUND');
      err.status = 404;
      throw err;
    }
    if (ownerResult.rows[0].owner_user_id !== ownerUserId) {
      const err = new DbError('Not authorized for this game', 'FORBIDDEN');
      err.status = 403;
      throw err;
    }

    const gameResult = await client.query(
      `SELECT game_state FROM games WHERE id = $1 FOR UPDATE`,
      [gameId]
    );
    const gameState =
      typeof gameResult.rows[0].game_state === 'string'
        ? JSON.parse(gameResult.rows[0].game_state)
        : gameResult.rows[0].game_state;

    let nextState;
    try {
      nextState = transitionFn(gameState);
    } catch (stateErr) {
      const err = new DbError(stateErr.message, 'INVALID_TRANSITION');
      err.status = 409;
      throw err;
    }

    await client.query(
      `UPDATE games SET game_state = $1 WHERE id = $2`,
      [JSON.stringify(nextState), gameId]
    );
    return nextState.state;
  });
}

module.exports = {
  DbError,
  createPool,
  migrate,
  upsertUser,
  withTransaction,
  createGame,
  getGame,
  submitAnswer,
  getScore,
  transitionGame,
};