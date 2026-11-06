'use strict';

/**
 * Question service — sixth-grade fraction question CRUD + Elasticsearch search.
 *
 * Responsibilities (space-fractions.md lines 7-10; Architecture_View.md
 * lines 111-118):
 *   - CRUD for question records ({prompt, options:[string], correctAnswer}).
 *   - Real Elasticsearch-backed question search.
 *   - Server-side validation of question payloads against the shared exact
 *     rational fraction validator (correct_answer must be a single valid
 *     fraction).
 *
 * This module is a small Express service. It reads configuration from the
 * environment (DATABASE_URL, ELASTICSEARCH_URL, PORT) and can be run directly:
 *   node packages/question-service/src/index.js
 *
 * When no PostgreSQL/Elasticsearch is reachable the service still boots its
 * HTTP handler factory logic; the repository is injected so unit tests can
 * supply an in-memory adapter without external infrastructure.
 */

const express = require('express');
const { Client } = require('@elastic/elasticsearch');

const { parseFraction, formatFraction } = require('../../../src/shared/fraction');
const { PgQuestionRepository, InMemoryQuestionRepository, ValidationError } = require('./repository');
const { QuestionSearch } = require('./search');

const PORT = Number(process.env.QUESTION_SERVICE_PORT || process.env.PORT || 3002);

/**
 * Validate a question payload. Returns a normalized question object or throws
 * a ValidationError with a message suitable for a 400 response.
 *
 * Contract (space-fractions.md line 16, origin=assumption merged with the
 * original Question getPrompt/getOptions):
 *   - prompt: non-empty string
 *   - options: array of strings (may be empty)
 *   - correctAnswer: a single valid fraction string (integer or "a/b")
 */
function validateQuestionPayload(body) {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('request body must be a JSON object');
  }
  const prompt = body.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new ValidationError('prompt must be a non-empty string');
  }
  const options = body.options;
  if (!Array.isArray(options)) {
    throw new ValidationError('options must be an array of strings');
  }
  for (const opt of options) {
    if (typeof opt !== 'string') {
      throw new ValidationError('options must contain only strings');
    }
  }
  const correctAnswer = body.correctAnswer;
  if (typeof correctAnswer !== 'string') {
    throw new ValidationError('correctAnswer must be a string');
  }
  const parsed = parseFraction(correctAnswer);
  if (!parsed) {
    throw new ValidationError('correctAnswer must be a single valid fraction');
  }
  // Canonicalize to a stable "a/b" (or integer) form for storage consistency.
  return {
    prompt: prompt.trim(),
    options: options.slice(),
    correctAnswer: formatFraction(parsed),
  };
}

/**
 * Build the question-service Express app.
 *
 * @param {object} [deps]
 * @param {object} [deps.repository]  repository instance (pg or in-memory)
 * @param {object} [deps.search]      search adapter instance
 * @param {object} [deps.logger]      optional logger (default: console)
 * @returns {import('express').Express}
 */
function buildApp(deps = {}) {
  const repository = deps.repository || new InMemoryQuestionRepository();
  const search = deps.search || new QuestionSearch(null);
  const log = deps.logger || console;

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Health for orchestration/tests.
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'question-service' });
  });

  // List questions (admin UI needs this; no pagination requirement).
  app.get('/questions', async (req, res) => {
    try {
      const questions = await repository.list();
      res.status(200).json({ questions });
    } catch (err) {
      log.error('list questions failed', err.message);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // Get a single question by id.
  app.get('/questions/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
      }
      const q = await repository.get(id);
      if (!q) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json(q);
    } catch (err) {
      log.error('get question failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // Search questions via Elasticsearch (real client when configured).
  app.get('/questions/search', async (req, res) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      const results = await search.search(query);
      res.status(200).json({ questions: results });
    } catch (err) {
      log.error('search questions failed', err.message);
      res.status(500).json({ error: 'search_error' });
    }
  });

  // Validate-only endpoint (used by admin service before persisting).
  app.post('/questions/validate', (req, res) => {
    try {
      const normalized = validateQuestionPayload(req.body);
      res.status(200).json({ valid: true, question: normalized });
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message });
      }
      log.error('validate failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // Create a question.
  app.post('/questions', async (req, res) => {
    try {
      const normalized = validateQuestionPayload(req.body);
      const created = await repository.create(normalized);
      await search.index(created).catch((err) => {
        // Search indexing is best-effort; persistence keeps source of truth.
        log.warn('search index failed (non-fatal)', err.message);
      });
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message });
      }
      log.error('create question failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // Delete a question (idempotent 404 when missing).
  app.delete('/questions/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
      }
      const removed = await repository.remove(id);
      if (!removed) return res.status(404).json({ error: 'not_found' });
      await search.remove(id).catch((err) => log.warn('search remove failed', err.message));
      return res.status(204).end();
    } catch (err) {
      log.error('delete question failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return app;
}

/**
 * Build production dependencies: a PostgreSQL-backed repository and a real
 * Elasticsearch client + search adapter. Returns an object suitable for
 * buildApp().
 */
function buildProductionDeps() {
  const repository = new PgQuestionRepository(process.env.DATABASE_URL);

  let search = new QuestionSearch(null);
  if (process.env.ELASTICSEARCH_URL) {
    const client = new Client({ node: process.env.ELASTICSEARCH_URL });
    search = new QuestionSearch(client);
  }
  return { repository, search };
}

// Direct execution only (not on import, so tests can require buildApp).
if (require.main === module) {
  // Boot with production deps; when Postgres/ES are absent the repository
  // constructor does not connect eagerly, so the HTTP listener still starts.
  const { repository, search } = buildProductionDeps();
  const app = buildApp({ repository, search });
  const server = app.listen(PORT, () => {
    console.log(`question-service listening on :${PORT}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  buildApp,
  validateQuestionPayload,
  buildProductionDeps,
  ValidationError,
};