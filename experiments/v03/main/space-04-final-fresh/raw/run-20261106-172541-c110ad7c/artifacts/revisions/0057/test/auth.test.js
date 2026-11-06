'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildApp: buildAdminApp } = require('../packages/admin-service/src/index');
const { buildApp: buildUserApp } = require('../packages/user-service/src/index');
const { InMemoryUserRepository } = require('../packages/user-service/src/index');
const {
  InMemoryQuestionRepository,
} = require('../packages/question-service/src/repository');
const { AuthError } = require('../src/shared/oidc');
const { createInvoker } = require('./helpers/http');

/**
 * Authorization and credential tests for the admin/user services.
 *
 * These use in-memory repositories and a scripted verifier so the default
 * `npm test` runs without PostgreSQL, Redis, RabbitMQ or a live identity
 * provider, while still exercising the real route handlers and the OIDC
 * authorization boundary (space-fractions.md lines 15-16, 20-24, 32-34):
 *   - missing/invalid credentials -> 401
 *   - valid credentials without admin role -> 403 on admin endpoints
 *   - valid admin credentials -> 200/201/404 as appropriate
 */

/** A scripted verifier whose `verify` throws AuthError or returns a payload. */
function makeVerifier(behavior) {
  return {
    async verify(token) {
      if (behavior.throw) throw behavior.throw;
      if (behavior.invalidToken && behavior.invalidToken === token) {
        throw new AuthError('invalid signature');
      }
      return behavior.payload;
    },
  };
}

const ADMIN_PAYLOAD = {
  sub: 'admin-sub',
  preferred_username: 'admin',
  realm_access: { roles: ['admin'] },
};

const STUDENT_PAYLOAD = {
  sub: 'student-sub',
  preferred_username: 'student',
  realm_access: { roles: ['student'] },
};

/** Minimal in-process HTTP helper around an Express app (mirrors scoring tests). */
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

function request(app) {
  return {
    get(path, headers = {}) {
      return invoke(app, 'GET', path, null, headers);
    },
    post(path, body, headers = {}) {
      return invoke(app, 'POST', path, body, headers);
    },
    delete(path, headers = {}) {
      return invoke(app, 'DELETE', path, null, headers);
    },
  };
}

function bearer(sub) {
  return { authorization: `Bearer token-for-${sub}` };
}

function buildAdmin(overrides = {}) {
  const userRepository = new InMemoryUserRepository();
  const verifier = overrides.verifier || makeVerifier({ payload: ADMIN_PAYLOAD });
  const questionRepository = overrides.questionRepository || new InMemoryQuestionRepository();
  const app = buildAdminApp({
    userRepository,
    verifier,
    questionRepository,
    search: overrides.search || { index: async () => {}, remove: async () => {} },
    logger: { error() {}, warn() {} },
  });
  return { app, userRepository, verifier, questionRepository };
}

test('missing credentials return 401 on admin and user endpoints', async () => {
  const admin = buildAdmin();
  const list = await request(admin.app).get('/api/admin/questions');
  assert.equal(list.status, 401);
  assert.equal(list.body.error, 'unauthorized');

  const userApp = buildUserApp({
    repository: new InMemoryUserRepository(),
    verifier: makeVerifier({ payload: ADMIN_PAYLOAD }),
    logger: { error() {} },
  });
  const me = await request(userApp).get('/users/me');
  assert.equal(me.status, 401);
});

test('malformed authorization scheme returns 401', async () => {
  const admin = buildAdmin();
  const list = await request(admin.app).get('/api/admin/questions', {
    authorization: 'Basic abc123',
  });
  assert.equal(list.status, 401);
});

test('invalid token (verifier rejects) returns 401', async () => {
  const admin = buildAdmin({
    verifier: makeVerifier({ payload: ADMIN_PAYLOAD, invalidToken: 'token-for-unknown' }),
    questionRepository: null,
  });
  // Rebuild with a question repository (buildAdmin already set up; keep this
  // focused) — issue a GET with a token the verifier rejects.
  const list = await request(admin.app).get('/api/admin/questions', {
    authorization: 'Bearer token-for-unknown',
  });
  assert.equal(list.status, 401);
});

test('verifier throw AuthError propagates to 401', async () => {
  const admin = buildAdmin({
    verifier: makeVerifier({ throw: new AuthError('token expired') }),
  });
  const list = await request(admin.app).get('/api/admin/questions', bearer('admin-sub'));
  assert.equal(list.status, 401);
});

test('non-admin user receives 403 on admin endpoints', async () => {
  const admin = buildAdmin({ verifier: makeVerifier({ payload: STUDENT_PAYLOAD }) });
  const list = await request(admin.app).get('/api/admin/questions', bearer('student-sub'));
  assert.equal(list.status, 403);
  assert.equal(list.body.error, 'forbidden');

  const create = await request(admin.app).post(
    '/api/admin/questions',
    { prompt: '1/2 + 1/2?', options: ['1', '1/2', '2'], correctAnswer: '1' },
    bearer('student-sub'),
  );
  assert.equal(create.status, 403);

  const del = await request(admin.app).delete('/api/admin/questions/1', bearer('student-sub'));
  assert.equal(del.status, 403);
});

test('admin can list, create, and delete questions', async () => {
  const admin = buildAdmin();

  const create = await request(admin.app).post(
    '/api/admin/questions',
    { prompt: '1/2 + 1/4?', options: ['3/4', '2/6', '1/4'], correctAnswer: '3/4' },
    bearer('admin-sub'),
  );
  assert.equal(create.status, 201);
  assert.equal(create.body.id, 1);
  assert.equal(create.body.prompt, '1/2 + 1/4?');
  assert.equal('correctAnswer' in create.body, true);

  const list = await request(admin.app).get('/api/admin/questions', bearer('admin-sub'));
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.questions));
  assert.equal(list.body.questions.length, 1);
  assert.equal(list.body.questions[0].correctAnswer, '3/4');

  const del = await request(admin.app).delete('/api/admin/questions/1', bearer('admin-sub'));
  assert.equal(del.status, 200);

  const delMissing = await request(admin.app).delete('/api/admin/questions/1', bearer('admin-sub'));
  assert.equal(delMissing.status, 404);
});

test('admin create validates malformed fraction -> 400', async () => {
  const admin = buildAdmin();
  const bad = await request(admin.app).post(
    '/api/admin/questions',
    { prompt: 'What?', options: ['a', 'b'], correctAnswer: 'not-a-fraction' },
    bearer('admin-sub'),
  );
  assert.equal(bad.status, 400);
});

test('user-service resolves admin and student principals with roles', async () => {
  const repo = new InMemoryUserRepository();
  const userApp = buildUserApp({
    repository: repo,
    verifier: makeVerifier({ payload: ADMIN_PAYLOAD }),
    logger: { error() {} },
  });

  const me = await request(userApp).get('/users/me', bearer('admin-sub'));
  assert.equal(me.status, 200);
  assert.equal(me.body.subject, 'admin-sub');
  assert.deepEqual(me.body.roles, ['admin']);

  // Verify the numeric id mapping persisted the subject.
  const stored = await repo.findBySubject('admin-sub');
  assert.ok(stored, 'subject should be lazily created');
  assert.equal(me.body.id, stored.id);
});