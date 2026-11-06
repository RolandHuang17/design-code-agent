'use strict';

/**
 * Question repository — persistence layer for the question service.
 *
 * Provides two implementations behind a common interface:
 *   - PgQuestionRepository: PostgreSQL 16 source of truth (schema
 *     sql/migrations/001_schema.sql). Questions are stored with options as a
 *     JSONB array and correct_answer as a canonical single-fraction TEXT.
 *   - InMemoryQuestionRepository: dependency-injection test adapter used by the
 *     unit tests so the default `npm test` runs without live PostgreSQL.
 *
 * Exposes the shared ValidationError so the index.js route factory can branch
 * 400-vs-500 error handling without duplicating the error type.
 *
 * Repository interface (consumed by packages/question-service/src/index.js):
 *   list()                 -> Promise<Array<{id,prompt,options,correctAnswer}>>
 *   get(id)                -> Promise<question|null>
 *   create({prompt,options,correctAnswer}) -> Promise<question-with-id>
 *   remove(id)             -> Promise<boolean>  (true when a row was deleted)
 */

const { Pool } = require('pg');

/** Validation error thrown for malformed question payloads (=> HTTP 400). */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Shared row -> API shape mapping (snake_case column -> camelCase API key). */
function rowToQuestion(row) {
  return {
    id: row.id,
    prompt: row.prompt,
    options: Array.isArray(row.options) ? row.options.slice() : [],
    correctAnswer: row.correct_answer,
  };
}

/**
 * PostgreSQL-backed question repository.
 *
 * Constructed lazily: the pg Client only opens a connection on first use so the
 * HTTP listener can still boot when Postgres is momentarily unreachable
 * (bounded downstream timeouts are layered on top by the service).
 */
class PgQuestionRepository {
  constructor(connectionString) {
    this.client = new Client({ connectionString });
  }

  async _ensureConnected() {
    if (!this._connected) {
      await this.client.connect();
      this._connected = true;
    }
  }

  async list() {
    await this._ensureConnected();
    const res = await this.client.query(
      'SELECT id, prompt, options, correct_answer FROM questions ORDER BY id ASC',
    );
    return res.rows.map(rowToQuestion);
  }

  async get(id) {
    await this._ensureConnected();
    const res = await this.client.query(
      'SELECT id, prompt, options, correct_answer FROM questions WHERE id = $1',
      [id],
    );
    return res.rows.length ? rowToQuestion(res.rows[0]) : null;
  }

  async create({ prompt, options, correctAnswer }) {
    await this._ensureConnected();
    const res = await this.client.query(
      `INSERT INTO questions (prompt, options, correct_answer)
       VALUES ($1, $2, $3)
       RETURNING id, prompt, options, correct_answer`,
      [prompt, JSON.stringify(options || []), correctAnswer],
    );
    return rowToQuestion(res.rows[0]);
  }

  async remove(id) {
    await this._ensureConnected();
    const res = await this.client.query('DELETE FROM questions WHERE id = $1', [id]);
    return res.rowCount > 0;
  }

  async close() {
    if (this._connected) {
      await this.client.end();
      this._connected = false;
    }
  }
}

/**
 * In-memory repository for unit tests. Backed by a plain Map with an
 * auto-incrementing id counter so tests exercise real route/validation logic
 * without external infrastructure.
 */
class InMemoryQuestionRepository {
  constructor() {
    this.rows = new Map();
    this.nextId = 1;
  }

  async list() {
    return Array.from(this.rows.values()).map(rowToQuestion);
  }

  async get(id) {
    const row = this.rows.get(id);
    return row ? rowToQuestion(row) : null;
  }

  async create({ prompt, options, correctAnswer }) {
    const id = this.nextId++;
    const row = {
      id,
      prompt,
      options: Array.isArray(options) ? options.slice() : [],
      correct_answer: correctAnswer,
    };
    this.rows.set(id, row);
    return rowToQuestion(row);
  }

  async remove(id) {
    return this.rows.delete(id);
  }

  async close() {
    this.rows.clear();
  }
}

module.exports = {
  PgQuestionRepository,
  InMemoryQuestionRepository,
  ValidationError,
  rowToQuestion,
};