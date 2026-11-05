/**
 * Integration test helpers for Space Fractions.
 *
 * Purpose: allow HTTP-boundary integration tests of the real service route
 * modules WITHOUT requiring live PostgreSQL/Redis/RabbitMQ/Keycloak.
 *
 * Strategy:
 *   - Inject a fake `@spacefractions/shared/db` (in-memory row store) into the
 *     require cache, plus fake cache/mq modules, so the real route handlers
 *     exercise real request/response/error-handling logic.
 *   - Use the REAL auth module (`validateToken` performs structural + issuer/
 *     audience/expiry checks; signature verification is exercised by the
 *     separate acceptance/auth profile). We craft local JWTs for known
 *     identities (admin/student).
 *   - Mount the real router into a fresh Express app and serve over HTTP on an
 *     ephemeral port, driving each request with `fetch`.
 *
 * These files live under test/integration/ and are invoked via
 * `npm run test:integration` (node --test). They do not require full
 * infrastructure; the full stack is exercised by compose and the auth profile.
 */

const express = require('express');
const path = require('node:path');
const { once } = require('node:events');

const DB_MODULE_PATH = require.resolve('@spacefractions/shared/db');
const CACHE_MODULE_PATH = require.resolve('@spacefractions/shared/cache');
const MQ_MODULE_PATH = require.resolve('@spacefractions/shared/mq');
const AUTH_MODULE_PATH = require.resolve('@spacefractions/shared/auth');

const ISSUER = 'http://keycloak:8080/realms/spacefractions';
const AUDIENCE = 'account';

/**
 * Build a fake in-memory DB implementing the query surface used by services.
 * The store is a plain object with arrays for games/questions/answers/users.
 * `query`/`queryOne` implement a small SQL pattern matcher sufficient for the
 * route handlers under test. Unknown SQL throws so coverage gaps surface.
 */
function createFakeDb(initialState = {}) {
  const store = {
    users: [],
    questions: [],
    games: [],
    answers: [],
    nextGameId: 1,
    nextQuestionId: 1,
    nextAnswerId: 1,
    nextUserId: 1,
    ...initialState
  };

  function findGame(id) { return store.games.find((g) => g.id === id); }

  function handleQuery(sql, params = []) {
    const s = sql.trim();

    // ----- games -----
    if (/SELECT \* FROM games WHERE id = \$1$/.test(s)) {
      return { rows: store.games.filter((g) => g.id === params[0]) };
    }
    if (/SELECT id FROM questions ORDER BY created_at/.test(s)) {
      return { rows: store.questions.map((q) => ({ id: q.id })) };
    }
    if (/INSERT INTO games \(/.test(s)) {
      // params: [user_id, state, score, question_ids, current_question_index]
      const game = {
        id: store.nextGameId++,
        user_id: params[0],
        state: params[1],
        score: params[2],
        question_ids: params[3],
        current_question_index: params[4]
      };
      store.games.push(game);
      return { rows: [game] };
    }
    if (/UPDATE games SET state = 'paused'/.test(s)) {
      const game = findGame(params[0]);
      if (game && game.state === 'playing') { game.state = 'paused'; return { rows: [game] }; }
      return { rows: [] };
    }
    if (/^UPDATE games SET state = 'playing'/.test(s)) {
      const game = findGame(params[0]);
      if (game && game.state === 'paused') { game.state = 'playing'; return { rows: [game] }; }
      return { rows: [] };
    }
    if (/UPDATE games SET score = score \+ \$1/.test(s)) {
      const game = findGame(params[1]);
      if (game) game.score += params[0];
      return { rows: [game] };
    }
    if (/UPDATE games SET current_question_index = \$1, state = \$2/.test(s)) {
      const game = findGame(params[2]);
      if (game) { game.current_question_index = params[0]; game.state = params[1]; }
      return { rows: [game] };
    }
    if (/UPDATE games SET current_question_index = \$1, state = \$2, updated_at/.test(s)) {
      const game = findGame(params[2]);
      if (game) { game.current_question_index = params[0]; game.state = params[1]; }
      return { rows: [game] };
    }

    // ----- questions -----
    if (/SELECT id, prompt, options FROM questions WHERE id = \$1$/.test(s)) {
      return { rows: store.questions.filter((q) => q.id === params[0]).map(q => ({ id: q.id, prompt: q.prompt, options: q.options })) };
    }
    if (/SELECT id, correct_answer FROM questions WHERE id = \$1/.test(s)) {
      return { rows: store.questions.filter((q) => q.id === params[0]).map(q => ({ id: q.id, correct_answer: q.correct_answer })) };
    }
    if (/SELECT id, prompt, options, created_at, updated_at\s*FROM questions WHERE id = \$1/.test(s)) {
      return { rows: store.questions.filter((q) => q.id === params[0]).map(q => ({ id: q.id, prompt: q.prompt, options: q.options, created_at: q.created_at, updated_at: q.updated_at })) };
    }
    if (/SELECT id, prompt, options FROM questions ORDER BY created_at DESC LIMIT \$1/.test(s)) {
      return { rows: store.questions.map(q => ({ id: q.id, prompt: q.prompt, options: q.options })).slice(0, params[0]) };
    }
    if (/SELECT id, prompt, options FROM questions WHERE id = ANY/.test(s)) {
      const ids = params[0] || [];
      return { rows: store.questions.filter(q => ids.includes(q.id)).map(q => ({ id: q.id, prompt: q.prompt, options: q.options })) };
    }
    if (/FROM questions\s+ORDER BY created_at DESC\s+LIMIT \$1\b/.test(s)) {
      return { rows: store.questions.map(q => ({ id: q.id, prompt: q.prompt, options: q.options })).slice(0, params[0]) };
    }
    if (/INSERT INTO questions \(prompt, options, correct_answer, created_by\)/.test(s)) {
      const row = {
        id: store.nextQuestionId++,
        prompt: params[0],
        options: JSON.parse(params[1]),
        correct_answer: params[2],
        created_by: params[3],
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:00Z')
      };
      store.questions.push(row);
      return { rows: [row] };
    }
    if (/SELECT id, prompt, options, correct_answer, created_by, created_at, updated_at\s*FROM questions ORDER BY created_at DESC LIMIT \$1/.test(s)) {
      return { rows: store.questions.map(q => ({ ...q })).slice(0, params[0]) };
    }
    if (/SELECT id, prompt, options, correct_answer, created_by, created_at, updated_at\s*FROM questions WHERE id = \$1/.test(s)) {
      return { rows: store.questions.filter((q) => q.id === params[0]) };
    }
    if (/UPDATE questions\s+SET prompt = \$2, options = \$3, correct_answer = \$4/.test(s)) {
      const q = store.questions.find((x) => x.id === params[0]);
      if (q) { q.prompt = params[1]; q.options = JSON.parse(params[2]); q.correct_answer = params[3]; }
      return { rows: [q] };
    }
    if (/DELETE FROM questions WHERE id = \$1 RETURNING id/.test(s)) {
      const idx = store.questions.findIndex((x) => x.id === params[0]);
      if (idx === -1) return { rows: [] };
      const [rm] = store.questions.splice(idx, 1);
      return { rows: [{ id: rm.id }] };
    }
    if (/SELECT id FROM questions WHERE id = \$1$/.test(s)) {
      return { rows: store.questions.filter((q) => q.id === params[0]).map(q => ({ id: q.id })) };
    }

    // ----- game_answers -----
    if (/SELECT \* FROM game_answers WHERE game_id = \$1 AND question_id = \$2/.test(s)) {
      return { rows: store.answers.filter(a => a.game_id === params[0] && a.question_id === params[1]) };
    }
    if (/INSERT INTO game_answers /.test(s)) {
      const id = store.nextAnswerId++;
      const row = { id, game_id: params[0], question_id: params[1], answer: params[2], correct: params[3], scored: params[4] };
      // unique (game_id, question_id) upsert emulation
      const existing = store.answers.find(a => a.game_id === row.game_id && a.question_id === row.question_id);
      if (existing) {
        existing.answer = row.answer;
        existing.correct = row.correct || existing.correct;
        existing.scored = existing.scored || row.scored;
        return { rows: [existing] };
      }
      store.answers.push(row);
      return { rows: [row] };
    }
    if (/UPDATE game_answers SET answer = \$1, correct = TRUE, scored = TRUE WHERE id = \$2/.test(s)) {
      const row = store.answers.find(a => a.id === params[1]);
      if (row) { row.answer = params[0]; row.correct = true; row.scored = true; }
      return { rows: [row] };
    }

    // ----- users -----
    if (/SELECT \* FROM users WHERE sub = \$1/.test(s)) {
      return { rows: store.users.filter(u => u.sub === params[0]) };
    }
    if (/SELECT id FROM users WHERE sub = \$1/.test(s)) {
      return { rows: store.users.filter(u => u.sub === params[0]).map(u => ({ id: u.id })) };
    }
    if (/INSERT INTO users \(sub, username, email\)/.test(s)) {
      const row = { id: store.nextUserId++, sub: params[0], username: params[1], email: params[2], created_at: new Date('2024-01-01T00:00:00Z') };
      store.users.push(row);
      return { rows: [row] };
    }

    throw new Error(`Unexpected SQL in integration fake DB: ${sql.slice(0, 120)}`);
  }

  return {
    store,
    query: async (sql, params) => handleQuery(sql, params),
    queryOne: async (sql, params) => {
      const r = await handleQuery(sql, params);
      return r.rows[0] || null;
    }
  };
}

/**
 * Fake cache (in-memory Map). get/set/del/healthCheck enough for handlers.
 */
function createFakeCache() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    set: async (k, v) => { map.set(k, v); },
    del: async (k) => { map.delete(k); },
    healthCheck: async () => true
  };
}

/**
 * Fake MQ: records published score events, expose publishScoreUpdated.
 */
function createFakeMQ() {
  const events = [];
  return {
    events,
    publishScoreUpdated: async (gameId, userId, score, questionId) => {
      events.push({ gameId, userId, score, questionId });
    }
  };
}

/**
 * Build a JWT header/payload/signature string for the REAL validateToken
 * (which does structural + issuer/audience/exp checks, not signature).
 */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeToken(claims, opts = {}) {
  const header = b64url({ alg: 'RS256', typ: 'JWT', kid: opts.kid || 'k1' });
  const payload = b64url({
    iss: claims.iss ?? ISSUER,
    aud: claims.aud ?? AUDIENCE,
    exp: claims.exp ?? Math.floor(Date.now() / 1000) + 3600,
    sub: claims.sub,
    preferred_username: claims.preferred_username || claims.sub,
    email: claims.email,
    realm_access: claims.realm_access || { roles: claims.roles || [] },
    ...claims
  });
  return `${header}.${payload}.fake-signature`;
}

const ADMIN_TOKEN = () => makeToken({ sub: 'admin-user-sub', roles: ['admin', 'user'] });
const STUDENT_TOKEN = () => makeToken({ sub: 'student-user-sub', roles: ['user'] });
const OTHER_TOKEN = () => makeToken({ sub: 'other-user-sub', roles: ['user'] });

/**
 * Build an Express app with the provided router mounted at `mountPath`,
 * JSON parsing, and the shared error handler. Returns the started server and
 * a base URL plus helpers to make requests and stop the server.
 */
async function startApp(router, mountPath = '/api/games') {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  const { errorHandler } = require('@spacefractions/shared/errors');
  app.use(errorHandler);

  const server = app.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    port,
    request: (subPath, options = {}) => fetch(`${baseUrl}${subPath}`, options),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * Install fake modules into require cache and reload target route module(s).
 * Returns a restore function.
 */
function installFakes({ db, cache, mq, auth }) {
  const saved = {};
  const paths = { db: DB_MODULE_PATH, cache: CACHE_MODULE_PATH, mq: MQ_MODULE_PATH, auth: AUTH_MODULE_PATH };

  for (const [key, val] of Object.entries({ db, cache, mq, auth })) {
    const p = paths[key];
    if (!val) continue;
    saved[key] = require.cache[p];
    require.cache[p] = { id: p, filename: p, loaded: true, exports: val };
  }

  return function restore() {
    for (const [key, val] of Object.entries(saved)) {
      const p = paths[key];
      if (val === undefined) {
        delete require.cache[p];
      } else {
        require.cache[p] = val;
      }
    }
    if (db) delete require.cache[require.resolve('../../services/game-service/src/game-engine.js')];
    if (db) delete require.cache[require.resolve('../../services/game-service/src/routes.js')];
    delete require.cache[require.resolve('../../services/admin-service/src/routes.js')];
    delete require.cache[require.resolve('../../services/question-service/src/routes.js')];
    delete require.cache[require.resolve('../../services/user-service/src/routes.js')];
  };
}

/**
 * Seed questions matching the real seed (ids 1..3) with known correct answers.
 */
function seedQuestions(store) {
  const qs = [
    { id: 1, prompt: 'What is 1/2 + 1/4?', options: ['1/6', '3/4', '2/6', '1/8'], correct_answer: '3/4' },
    { id: 2, prompt: 'What is 3/5 - 1/5?', options: ['2/5', '4/5', '1/5', '3/10'], correct_answer: '2/5' },
    { id: 3, prompt: 'What is 2/3 x 3/4?', options: ['6/12', '5/7', '1/2', '2/4'], correct_answer: '1/2' }
  ];
  qs.forEach((q) => store.questions.push(q));
  store.nextQuestionId = 4;
  return qs;
}

function seedUsers(store) {
  const users = [
    { id: 1, sub: 'admin-user-sub', username: 'admin', email: 'admin@spacefractions.local' },
    { id: 2, sub: 'student-user-sub', username: 'student', email: 'student@spacefractions.local' },
    { id: 3, sub: 'other-user-sub', username: 'other', email: 'other@spacefractions.local' }
  ];
  users.forEach((u) => store.users.push({ ...u, created_at: new Date('2024-01-01T00:00:00Z') }));
  store.nextUserId = 4;
  return users;
}

module.exports = {
  ISSUER,
  AUDIENCE,
  dbPath: DB_MODULE_PATH,
  cachePath: CACHE_MODULE_PATH,
  mqPath: MQ_MODULE_PATH,
  authPath: AUTH_MODULE_PATH,
  createFakeDb,
  createFakeCache,
  createFakeMQ,
  makeToken,
  ADMIN_TOKEN,
  STUDENT_TOKEN,
  OTHER_TOKEN,
  startApp,
  installFakes,
  seedQuestions,
  seedUsers
};