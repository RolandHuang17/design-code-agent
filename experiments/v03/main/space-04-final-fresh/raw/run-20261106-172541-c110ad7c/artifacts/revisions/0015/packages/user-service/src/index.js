'use strict';

/**
 * User service — OIDC identity resolution and authorization for Space Fractions.
 *
 * Responsibilities (space-fractions.md lines 10-14, 37-44):
 *   - Validate a Bearer OIDC access token (issuer/audience/JWKS signature) via
 *     the shared `src/shared/oidc.js` helpers.
 *   - Map the verified `sub` claim to a numeric internal user id using the
 *     `users` table (UNIQUE subject) — creating the user lazily on first sight
 *     so authenticated players always have an owner id for game authorization.
 *   - Expose owner/admin authorization helpers consumed by the game-service and
 *     admin-service (the gateway fans out requests; this service is the single
 *     place that resolves JWT `sub` -> `users.id`).
 *
 * OIDC environment contract (space-fractions.md line 40):
 *   - OIDC_ISSUER  public issuer origin.
 *   - OIDC_JWKS_URI internal-certificates endpoint (default http://keycloak:8080/...).
 *   - OIDC_AUDIENCE expected audience (default "account").
 *   - OIDC_ADMIN_ROLE role name conferring administrator privileges (default "admin").
 *
 * The service boots its HTTP listener even when PostgreSQL is unreachable: the
 * pg `Client` connects lazily, and unit tests inject an in-memory repository.
 */

const express = require('express');
const { Client } = require('pg');

const oidc = require('../../shared/oidc');

const PORT = Number(process.env.USER_SERVICE_PORT || process.env.PORT || 3003);

/** Validation/authorization error helper (mirrors shared AuthError semantics). */
class UserServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'UserServiceError';
    this.status = status;
  }
}

/**
 * Repository interface:
 *   findOrCreateBySubject(subject, profile) -> Promise<User>
 *   findBySubject(subject)                 -> Promise<User|null>
 *   findById(id)                           -> Promise<User|null>
 * where User = { id, subject, profile, roles }.
 */

/** PostgreSQL-backed user repository (source of truth: sql/migrations/001_schema.sql). */
class PgUserRepository {
  constructor(connectionString) {
    this.client = new Client({ connectionString });
  }

  async _ensureConnected() {
    if (!this._connected) {
      await this.client.connect();
      this._connected = true;
    }
  }

  async findOrCreateBySubject(subject, profile = '') {
    await this._ensureConnected();
    await this.client.query('BEGIN');
    try {
      // Lock-free upsert on the UNIQUE(subject) index; profile defaults applied
      // at creation but not overwritten on re-sight (name ownership preserved).
      const res = await this.client.query(
        `INSERT INTO users (subject, profile)
         VALUES ($1, $2)
         ON CONFLICT (subject) DO UPDATE SET updated_at = now()
         RETURNING id, subject, profile, roles`,
        [subject, profile],
      );
      await this.client.query('COMMIT');
      return rowToUser(res.rows[0]);
    } catch (err) {
      await this.client.query('ROLLBACK');
      throw err;
    }
  }

  async findBySubject(subject) {
    await this._ensureConnected();
    const res = await this.client.query(
      'SELECT id, subject, profile, roles FROM users WHERE subject = $1',
      [subject],
    );
    return res.rows.length ? rowToUser(res.rows[0]) : null;
  }

  async findById(id) {
    await this._ensureConnected();
    const res = await this.client.query(
      'SELECT id, subject, profile, roles FROM users WHERE id = $1',
      [id],
    );
    return res.rows.length ? rowToUser(res.rows[0]) : null;
  }

  async close() {
    if (this._connected) {
      await this.client.end();
      this._connected = false;
    }
  }
}

/** In-memory adapter for unit tests (no live PostgreSQL required). */
class InMemoryUserRepository {
  constructor() {
    this.rows = new Map(); // id -> User
    this.bySubject = new Map(); // subject -> id
    this.nextId = 1;
  }

  async findOrCreateBySubject(subject, profile = '') {
    const existing = await this.findBySubject(subject);
    if (existing) return existing;
    const id = this.nextId++;
    const user = { id, subject, profile, roles: [] };
    this.rows.set(id, user);
    this.bySubject.set(subject, id);
    return user;
  }

  async findBySubject(subject) {
    const id = this.bySubject.get(subject);
    return id ? this.rows.get(id) : null;
  }

  async findById(id) {
    return this.rows.get(id) || null;
  }

  async close() {
    this.rows.clear();
    this.bySubject.clear();
  }
}

function rowToUser(row) {
  return {
    id: row.id,
    subject: row.subject,
    profile: row.profile,
    roles: Array.isArray(row.roles) ? row.roles.slice() : [],
  };
}

/**
 * Resolve the authenticated identity from an Authorization header.
 *
 * Verifies the token, extracts `sub` and roles, and maps `sub` to the numeric
 * internal user id via the repository (lazily creating the user). Returns
 * { id, subject, profile, roles } on success.
 *
 * @param {object} repo       user repository
 * @param {object} verifier   OIDC token verifier ({ verify })
 * @param {string|undefined} authorizationHeader
 * @param {string} [profile]  profile name to persist on first sight
 * @returns {Promise<object>}
 */
async function authenticate(repo, verifier, authorizationHeader, profile) {
  const token = oidc.bearerToken(authorizationHeader);
  const payload = await verifier.verify(token);
  const sub = payload.sub;
  const roles = oidc.extractRoles(payload);
  const existing = await repo.findBySubject(sub);
  const principal = existing || (await repo.findOrCreateBySubject(sub, profile || payload.preferred_username || sub));
  return {
    id: principal.id,
    subject: sub,
    profile: principal.profile,
    roles,
  };
}

/**
 * Build the user-service Express app.
 *
 * @param {object} [deps]
 * @param {object} [deps.repository] user repository (pg or in-memory)
 * @param {object} [deps.verifier]   OIDC token verifier ({ verify })
 * @param {object} [deps.logger]     logger (default console)
 * @returns {import('express').Express}
 */
function buildApp(deps = {}) {
  const repository = deps.repository || new InMemoryUserRepository();
  const verifier =
    deps.verifier ||
    oidc.createTokenVerifier({
      issuer: process.env.OIDC_ISSUER,
      audience: process.env.OIDC_AUDIENCE,
      jwksUri: process.env.OIDC_JWKS_URI,
    });
  const log = deps.logger || console;

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Health for orchestration/tests.
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'user-service' });
  });

  /**
   * Authenticate the bearer token and return the resolved principal. Used by
   * the gateway's downstream routing and by tests for owner/admin checks.
   *   200 {id, subject, profile, roles}
   *   401 missing/invalid credentials
   */
  app.post('/auth/verify', async (req, res) => {
    try {
      const principal = await authenticate(repository, verifier, req.headers.authorization);
      res.status(200).json(principal);
    } catch (err) {
      if (err && err.name === 'AuthError') {
        return res.status(401).json({ error: 'unauthorized' });
      }
      log.error('auth verify failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  /**
   * Resolve a verified subject to its internal numeric id (no side effects when
   * the user already exists; lazily creates when absent). Mirrors /auth/verify
   * but makes the id-mapping contract explicit for the async service.
   *   200 {id, subject, profile}
   *   401 missing/invalid credentials
   */
  app.get('/users/me', async (req, res) => {
    try {
      const principal = await authenticate(repository, verifier, req.headers.authorization);
      res.status(200).json({
        id: principal.id,
        subject: principal.subject,
        profile: principal.profile,
        roles: principal.roles,
      });
    } catch (err) {
      if (err && err.name === 'AuthError') {
        return res.status(401).json({ error: 'unauthorized' });
      }
      log.error('users/me failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  /**
   * Fetch a user by numeric internal id (used by game/admin services to check
   * ownership without re-walking the token). No authorization requirement for a
   * read of profile metadata; secrets are never exposed.
   */
  app.get('/users/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
      }
      const user = await repository.findById(id);
      if (!user) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json(user);
    } catch (err) {
      log.error('get user failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return app;
}

function buildProductionDeps() {
  const repository = new PgUserRepository(process.env.DATABASE_URL);
  const verifier = oidc.createTokenVerifier({
    issuer: process.env.OIDC_ISSUER,
    audience: process.env.OIDC_AUDIENCE,
    jwksUri: process.env.OIDC_JWKS_URI,
  });
  return { repository, verifier };
}

// Direct execution only (not on import, so tests can require buildApp).
if (require.main === module) {
  const { repository, verifier } = buildProductionDeps();
  const app = buildApp({ repository, verifier });
  const server = app.listen(PORT, () => {
    console.log(`user-service listening on :${PORT}`);
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
  authenticate,
  PgUserRepository,
  InMemoryUserRepository,
  UserServiceError,
};