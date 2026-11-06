'use strict';

/**
 * Admin service — authenticated administrator question CRUD for Space Fractions.
 *
 * Responsibilities (space-fractions.md lines 15-16; Architecture_View.md
 * lines 3-14 — the "Update Questions" admin use case):
 *   - Authenticate a Bearer OIDC access token and authorize the ADMIN role.
 *   - POST   /api/admin/questions     -> 201 {id,prompt,options,correctAnswer}
 *   - GET    /api/admin/questions     -> 200 {questions:[...]}
 *   - DELETE /api/admin/questions/:id -> 200 (or 204), 404 when id missing.
 *   - Normal (non-admin) users receive 403; missing/invalid credentials 401.
 *
 * The admin service is the authorization boundary. It reuses:
 *   - `src/shared/oidc.js`            for token verification and admin-role check.
 *   - `packages/user-service`         `authenticate()` to map verified `sub` to a
 *     numeric internal user id (single home for JWT sub -> users.id resolution).
 *   - `packages/question-service`      `validateQuestionPayload()` + repository +
 *     `QuestionSearch` so question writes and search indexing stay consistent
 *     with the question service (correctAnswer validated as a single exact
 *     fraction; options array of strings).
 *
 * OIDC environment contract (space-fractions.md line 40):
 *   - OIDC_ISSUER/OIDC_AUDIENCE/OIDC_JWKS_URI/OIDC_ADMIN_ROLE (default "admin").
 *
 * Like the question/user services, the pg `Client` connects lazily so the HTTP
 * listener still boots when PostgreSQL is temporarily unreachable. Unit tests
 * inject in-memory repositories and a scripted token verifier.
 */

const express = require('express');

const oidc = require('../../shared/oidc');
const {
  validateQuestionPayload,
  ValidationError: QuestionValidationError,
} = require('../../question-service/src/index');
const {
  InMemoryQuestionRepository,
  PgQuestionRepository,
} = require('../../question-service/src/repository');
const { QuestionSearch } = require('../../question-service/src/search');
const {
  authenticate,
  InMemoryUserRepository,
  PgUserRepository,
} = require('../../user-service/src/index');

const PORT = Number(process.env.ADMIN_SERVICE_PORT || process.env.PORT || 3004);
const ADMIN_ROLE = () => process.env.OIDC_ADMIN_ROLE || 'admin';

/**
 * Build the admin-service Express app.
 *
 * @param {object} [deps]
 * @param {object} [deps.userRepository]  user repository (pg or in-memory)
 * @param {object} [deps.verifier]        OIDC token verifier ({ verify })
 * @param {object} [deps.questionRepository] question repository (pg or in-memory)
 * @param {object} [deps.search]          QuestionSearch adapter
 * @param {object} [deps.logger]          logger (default console)
 * @returns {import('express').Express}
 */
function buildApp(deps = {}) {
  const userRepository = deps.userRepository || new InMemoryUserRepository();
  const verifier =
    deps.verifier ||
    oidc.createTokenVerifier({
      issuer: process.env.OIDC_ISSUER,
      audience: process.env.OIDC_AUDIENCE,
      jwksUri: process.env.OIDC_JWKS_URI,
    });
  const questionRepository =
    deps.questionRepository || new InMemoryQuestionRepository();
  const search = deps.search || new QuestionSearch(null);
  const log = deps.logger || console;

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Health for orchestration/tests.
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'admin-service' });
  });

  /**
   * Resolve the authenticated principal and enforce the administrator role.
   * Throws UserServiceError for JSON-error mapping is avoided here; instead we
   * branch inside handlers via the thrown error's `name`/`status`. `authenticate`
   * throws a shared oidc.AuthError (401) on missing/invalid credentials.
   *
   * Returns { id, subject, profile, roles } for an admin, otherwise throws a
   * 403 error object we construct locally.
   */
  async function requireAdmin(req) {
    const principal = await authenticate(
      userRepository,
      verifier,
      req.headers.authorization,
    );
    if (!oidc.isAdmin({ realm_access: { roles: principal.roles } }, ADMIN_ROLE())) {
      const err = new Error('forbidden');
      err.name = 'ForbiddenError';
      err.status = 403;
      throw err;
    }
    return principal;
  }

  /**
   * List all questions (admin view). Contract: { questions: [...] }.
   *   200 on success; 401 missing/invalid credentials; 403 non-admin.
   */
  app.get('/api/admin/questions', async (req, res) => {
    try {
      await requireAdmin(req);
      const questions = await questionRepository.list();
      res.status(200).json({ questions });
    } catch (err) {
      if (err && err.name === 'AuthError') {
        return res.status(401).json({ error: 'unauthorized' });
      }
      if (err && err.name === 'ForbiddenError') {
        return res.status(403).json({ error: 'forbidden' });
      }
      log.error('list admin questions failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  /**
   * Create a question. Contract: 201 {id,prompt,options,correctAnswer}.
   * Malformed payload (bad prompt/options/fraction) -> 400; 401/403 as above.
   */
  app.post('/api/admin/questions', async (req, res) => {
    try {
      await requireAdmin(req);
      const normalized = validateQuestionPayload(req.body);
      const created = await questionRepository.create(normalized);
      await search.index(created).catch((indexErr) => {
        // Search indexing is best-effort; PostgreSQL remains the source of truth.
        log.warn('search index failed (non-fatal)', indexErr.message);
      });
      res.status(201).json(created);
    } catch (err) {
      if (err && err.name === 'AuthError') {
        return res.status(401).json({ error: 'unauthorized' });
      }
      if (err && err.name === 'ForbiddenError') {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (err instanceof QuestionValidationError) {
        return res.status(400).json({ error: err.message });
      }
      log.error('create admin question failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  /**
   * Delete a question by id. Contract: 200 (JSON ack) or 204 on success, 404 when
   * the id does not exist, 400 on a malformed id, 401/403 as above.
   */
  app.delete('/api/admin/questions/:id', async (req, res) => {
    try {
      await requireAdmin(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
      }
      const removed = await questionRepository.remove(id);
      if (!removed) return res.status(404).json({ error: 'not_found' });
      await search.remove(id).catch((removeErr) =>
        log.warn('search remove failed (non-fatal)', removeErr.message),
      );
      return res.status(200).json({ deleted: id });
    } catch (err) {
      if (err && err.name === 'AuthError') {
        return res.status(401).json({ error: 'unauthorized' });
      }
      if (err && err.name === 'ForbiddenError') {
        return res.status(403).json({ error: 'forbidden' });
      }
      log.error('delete admin question failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return app;
}

/**
 * Build production dependencies: PostgreSQL-backed user + question repositories,
 * a real OIDC verifier, and an Elasticsearch-backed QuestionSearch when
 * ELASTICSEARCH_URL is configured.
 */
function buildProductionDeps() {
  const userRepository = new PgUserRepository(process.env.DATABASE_URL);
  const questionRepository = new PgQuestionRepository(process.env.DATABASE_URL);
  const verifier = oidc.createTokenVerifier({
    issuer: process.env.OIDC_ISSUER,
    audience: process.env.OIDC_AUDIENCE,
    jwksUri: process.env.OIDC_JWKS_URI,
  });
  const { Client } = require('@elastic/elasticsearch');
  const search = process.env.ELASTICSEARCH_URL
    ? new QuestionSearch(new Client({ node: process.env.ELASTICSEARCH_URL }))
    : new QuestionSearch(null);
  return { userRepository, questionRepository, verifier, search };
}

// Direct execution only (not on import, so tests can require buildApp).
if (require.main === module) {
  const { userRepository, questionRepository, verifier, search } = buildProductionDeps();
  const app = buildApp({ userRepository, questionRepository, verifier, search });
  const server = app.listen(PORT, () => {
    console.log(`admin-service listening on :${PORT}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  buildApp,
  buildProductionDeps,
};