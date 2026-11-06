'use strict';

/**
 * Game repository — persistence layer for the game service.
 *
 * Provides two implementations behind a common interface:
 *   - PgGameRepository: PostgreSQL 16 source of truth. Score mutations are
 *     serialized per game and deduplicated in a single transaction; repeats
 *     rely on the UNIQUE (game_id, question_id) constraint in the `answers`
 *     table (sql/migrations/001_schema.sql) and are surfaced with a
 *     DUPLICATE_ANSWER code so the route layer can return 409.
 *   - InMemoryGameRepository: dependency-injection test adapter so the default
 *     `npm test` runs without live PostgreSQL while still exercising
 *     deduplication and owner checks.
 *
 * Repository interface consumed by packages/game-service/src/index.js:
 *   create(ownerId, questions)               -> {id,state,score}
 *   get(id)                                  -> game|null (contains questions
 *                                               WITH correctAnswer for scoring;
 *                                               the route layer strips it)
 *   setState(id, state)                      -> {id,state,score}
 *   scoreAnswer(id, questionId, answer, correct) -> Promise<{correct,score}>
 *        throws {code:'DUPLICATE_ANSWER'} on a repeated question
 *
 * Game shape (internal):
 *   { id, ownerId, state, score, questions: [{id,prompt,options,correctAnswer}] }
 */

const { Client } = require('pg');

/** Error thrown when a question has already been answered for a game (-> 409). */
class DuplicateAnswerError extends Error {
  constructor() {
    super('answer already recorded for this game');
    this.name = 'DuplicateAnswerError';
    this.code = 'DUPLICATE_ANSWER';
  }
}

/** snake_case game row -> internal game shape (questions filled separately). */
function rowToGame(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    state: row.state,
    score: row.score,
    questions: [],
  };
}

/** snake_case question row -> internal question shape (correctAnswer kept). */
function rowToGameQuestion(row) {
  return {
    id: row.id,
    prompt: row.prompt,
    options: Array.isArray(row.options) ? row.options.slice() : [],
    correctAnswer: row.correct_answer,
  };
}

/**
 * PostgreSQL-backed game repository.
 *
 * The pg Client opens its connection lazily (on first use) so the HTTP listener
 * can boot before Postgres is reachable; bounded downstream timeouts are layered
 * on by the service/gateway.
 *
 * Concurrency contract (space-fractions.md line 48): score updates serialize per
 * game via `SELECT ... FOR UPDATE` on the games row inside one owned
 * transaction. Both the answer INSERT and the score UPDATE happen in the same
 * transaction; the UNIQUE (game_id, question_id) constraint becomes the dedup
 * guard (no EXCLUDED in RETURNING — illegal on PG16). On any error the
 * transaction rolls back.
 */
class PgGameRepository {
  constructor(connectionString) {
    this.client = new Client({ connectionString });
  }

  async _ensureConnected() {
    if (!this._connected) {
      await this.client.connect();
      this._connected = true;
    }
  }

  async create(ownerId, questions) {
    await this._ensureConnected();
    await this.client.query('BEGIN');
    try {
      const gameRes = await this.client.query(
        `INSERT INTO games (owner_id, state, score)
         VALUES ($1, 'in_progress', 0)
         RETURNING id, owner_id, state, score`,
        [ownerId],
      );
      const game = rowToGame(gameRes.rows[0]);

      // Insert the ordered question set; position preserves stable order.
      for (let i = 0; i < questions.length; i += 1) {
        await this.client.query(
          `INSERT INTO game_questions (game_id, question_id, position)
           VALUES ($1, $2, $3)`,
          [game.id, questions[i].id, i],
        );
      }

      await this.client.query('COMMIT');

      // Attach the question records (including correctAnswer) for scoring and
      // the player-facing view (the route strips correctAnswer before sending).
      game.questions = questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        options: Array.isArray(q.options) ? q.options.slice() : [],
        correctAnswer: q.correctAnswer,
      }));
      return game;
    } catch (err) {
      await this.client.query('ROLLBACK');
      throw err;
    }
  }

  /** Load a game and its ordered questions, with correctAnswer for scoring. */
  async _loadGame(id) {
    const res = await this.client.query(
      `SELECT id, owner_id, state, score FROM games WHERE id = $1`,
      [id],
    );
    if (!res.rows.length) return null;
    const game = rowToGame(res.rows[0]);

    const qRes = await this.client.query(
      `SELECT q.id, q.prompt, q.options, q.correct_answer
         FROM game_questions gq
         JOIN questions q ON q.id = gq.question_id
        WHERE gq.game_id = $1
        ORDER BY gq.position ASC`,
      [id],
    );
    game.questions = qRes.rows.map(rowToGameQuestion);
    return game;
  }

  async get(id) {
    await this._ensureConnected();
    return this._loadGame(id);
  }

  async setState(id, state) {
    await this._ensureConnected();
    const res = await this.client.query(
      `UPDATE games SET state = $2, updated_at = now()
        WHERE id = $1
        RETURNING id, owner_id, state, score`,
      [id, state],
    );
    return res.rows.length ? rowToGame(res.rows[0]) : null;
  }

  /**
   * Record an answer and increment the score atomically.
   *
   * @param {number} id          game id
   * @param {number} questionId
   * @param {string} answer      submitted answer string (stored verbatim)
   * @param {boolean} correct    whether the answer is correct (pre-computed)
   * @returns {Promise<{correct:boolean, score:number}>}
   * @throws DuplicateAnswerError if this question was already answered
   */
  async scoreAnswer(id, questionId, answer, correct) {
    await this._ensureConnected();
    await this.client.query('BEGIN');
    try {
      // Serialize per game: lock the games row for the duration of the
      // transaction so concurrent answers to the same game cannot interleave.
      const lockRes = await this.client.query(
        `SELECT id, owner_id, state, score FROM games WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!lockRes.rows.length) {
        await this.client.query('ROLLBACK');
        return null;
      }

      // Dedup guard: the UNIQUE constraint also protects this, but checking
      // first gives a deterministic 409 without relying on error-code parsing.
      const dup = await this.client.query(
        `SELECT 1 FROM answers WHERE game_id = $1 AND question_id = $2`,
        [id, questionId],
      );
      if (dup.rows.length) {
        await this.client.query('ROLLBACK');
        throw new DuplicateAnswerError();
      }

      await this.client.query(
        `INSERT INTO answers (game_id, question_id, answer, correct)
         VALUES ($1, $2, $3, $4)`,
        [id, questionId, answer, correct],
      );

      const updated = correct
        ? await this.client.query(
            `UPDATE games SET score = score + 1, updated_at = now()
              WHERE id = $1
              RETURNING id, owner_id, state, score`,
            [id],
          )
        : await this.client.query(
            `UPDATE games SET updated_at = now()
              WHERE id = $1
              RETURNING id, owner_id, state, score`,
            [id],
          );

      await this.client.query('COMMIT');
      const game = rowToGame(updated.rows[0]);
      return { correct, score: game.score };
    } catch (err) {
      // Only roll back if a transaction is still open (the duplicate path above
      // already rolled back before throwing).
      try {
        await this.client.query('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  async close() {
    if (this._connected) {
      await this.client.end();
      this._connected = false;
    }
  }
}

/**
 * In-memory game repository for unit tests. Mirrors the PostgreSQL semantics
 * including deduplication (repeat answer does not increment score and throws
 * DuplicateAnswerError) so route tests exercise real behavior without a live
 * database.
 */
class InMemoryGameRepository {
  constructor() {
    this.rows = new Map();
    this.answers = new Map(); // `${gameId}:${questionId}` -> true
    this.nextId = 1;
  }

  async create(ownerId, questions) {
    const id = this.nextId++;
    const game = {
      id,
      ownerId,
      state: 'in_progress',
      score: 0,
      questions: questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        options: Array.isArray(q.options) ? q.options.slice() : [],
        correctAnswer: q.correctAnswer,
      })),
    };
    this.rows.set(id, game);
    return {
      id: game.id,
      ownerId: game.ownerId,
      state: game.state,
      score: game.score,
      questions: game.questions,
    };
  }

  async get(id) {
    const game = this.rows.get(id);
    if (!game) return null;
    return {
      id: game.id,
      ownerId: game.ownerId,
      state: game.state,
      score: game.score,
      questions: game.questions.map((q) => ({ ...q, options: q.options.slice() })),
    };
  }

  async setState(id, state) {
    const game = this.rows.get(id);
    if (!game) return null;
    game.state = state;
    return { id: game.id, ownerId: game.ownerId, state: game.state, score: game.score };
  }

  async scoreAnswer(id, questionId, answer, correct) {
    const game = this.rows.get(id);
    if (!game) return null;
    const key = `${id}:${questionId}`;
    if (this.answers.has(key)) {
      throw new DuplicateAnswerError();
    }
    this.answers.set(key, true);
    if (correct) game.score += 1;
    return { correct, score: game.score };
  }

  async close() {
    this.rows.clear();
    this.answers.clear();
  }
}

module.exports = {
  PgGameRepository,
  InMemoryGameRepository,
  DuplicateAnswerError,
  rowToGame,
  rowToGameQuestion,
};