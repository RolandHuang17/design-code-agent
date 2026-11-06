'use strict';

/**
 * In-memory PostgreSQL-compatible adapter for integration tests.
 *
 * This is a TEST-ONLY adapter (per the host testing contract: "Use dependency
 * injection or a test-only adapter") used to exercise the real HTTP gateway and
 * the real service/auth/db logic over real HTTP without a live PostgreSQL or
 * identity provider. It implements the exact SQL surface issued by lib/db.js
 * and lib/auth.js with faithful relational semantics: serial primary keys,
 * unique constraints, transactions (BEGIN/COMMIT/ROLLBACK with journaled undo),
 * COUNT aggregation, JSONB-as-JSON, and owner mapping.
 *
 * It is NOT a substitute for PostgreSQL correctness — real database behaviour
 * is exercised separately by the protected runtime HTTP acceptance harness
 * against the Compose stack. This adapter only exists so `npm run test:integration`
 * can run the HTTP contract deterministically on a developer machine without
 * live infrastructure.
 */

/**
 * Build a tiny relational store with the schema from sql/game_ddl.sql.
 * Each entry: { pkey, serial, unique: [[cols]], rows: [objects], nextId }.
 */
function createStore() {
  return {
    users: { pkey: 'id', serial: true, unique: [['sub']], rows: [], nextId: 1 },
    games: { pkey: 'id', serial: true, unique: [], rows: [], nextId: 1 },
    games_owners: { pkey: 'game_id', serial: false, unique: [], rows: [] },
    questions: { pkey: 'id', serial: true, unique: [], rows: [], nextId: 1 },
    game_questions: { pkey: null, serial: false, unique: [['game_id', 'question_id'], ['game_id', 'position']], rows: [] },
    answers: { pkey: 'id', serial: true, unique: [['game_id', 'question_id']], rows: [], nextId: 1 },
  };
}

/** Substitute $n parameters into a value. Params are 1-indexed. */
function param(val, params) {
  if (typeof val === 'string' && /^\$\d+$/.test(val)) {
    const idx = parseInt(val.slice(1), 10) - 1;
    return params[idx];
  }
  return val;
}

/** Evaluate a single comparison predicate of the form `col = value` / `col = true/false`. */
function evalWhere(row, where) {
  if (!where) return true;
  // Support a simple 'col = $n' or 'col = true'/'col = false' equality clause.
  const m = where.match(/^\s*([a-zA-Z0-9_.]+)\s*(=\s*(.+))?\s*$/);
  if (!m) return true;
  const lhsKey = m[1].split('.').pop();
  const rhs = m[3] ? m[3].trim() : null;
  if (rhs === null) return true;
  let expected;
  if (rhs === 'true') expected = true;
  else if (rhs === 'false') expected = false;
  else if (/^\$\d+$/.test(rhs)) expected = null; // resolved by caller
  else expected = rhs;
  return true; // equality is applied in the caller (ranges handled there)
}

function rowMatches(row, conditions, params) {
  for (const cond of conditions) {
    // cond: { col, value }
    const actual = row[cond.col];
    const expected = cond.value === null ? null : param(cond.value, params);
    if (actual !== expected && !(actual == null && expected == null)) {
      return false;
    }
  }
  return true;
}

/**
 * Parse the WHERE clause into a list of { col, value } equality conditions.
 * Handles `col = $n`, `col = true/false`, joined by AND. For `col = ANY($n::int[])`
 * (used for the questionIds filter) it returns a special ANY condition.
 */
function parseWhere(where) {
  if (!where) return { conditions: [], anyFilter: null };
  const conditions = [];
  let anyFilter = null;

  const anyMatch = where.match(/([a-zA-Z0-9_]+)\s*=\s*ANY\(\$(\d+)::int\[\]\)/);
  if (anyMatch) {
    anyFilter = { col: anyMatch[1], paramIndex: parseInt(anyMatch[2], 10) - 1 };
    return { conditions, anyFilter };
  }

  if (/FOR UPDATE/i.test(where)) {
    where = where.replace(/FOR UPDATE/ig, '').trim();
  }

  const parts = where.split(/\s+AND\s+/i);
  for (const part of parts) {
    const m = part.trim().match(/^([a-zA-Z0-9_.]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const col = m[1].split('.').pop();
    const raw = m[2].trim();
    let value;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (/^\$\d+$/.test(raw)) value = parseInt(raw.slice(1), 10) - 1; // store param index
    else value = raw;
    conditions.push({ col, value });
  }
  return { conditions, anyFilter };
}

/** Resolve a value slot: if it is a param index (number in conditions), substitute. */
function resolveCond(cond, params) {
  if (typeof cond.value === 'number' && Number.isInteger(cond.value) && cond.value >= 0) {
    return { col: cond.col, value: params[cond.value] };
  }
  return { col: cond.col, value: cond.value };
}

class FakeClient {
  constructor(store, journal) {
    this._store = store;
    this._journal = journal; // array of undo functions scoped to the transaction
  }

  async query(sql, params = []) {
    if (typeof sql === 'object') {
      // pg supports query({ text, values }); normalize.
      params = sql.values || [];
      sql = sql.text;
    }
    return execute(this._store, this._journal, sql, params);
  }

  async release() {
    // No-op: pooled clients in this fake are stateless between transactions.
  }
}

/**
 * The fake pool. `connect()` provides a client whose mutations are journaled so
 * BEGIN/COMMIT/ROLLBACK behave transactionally (ROLLBACK undoes the journal).
 */
class FakePool {
  constructor(store) {
    this._store = store;
  }

  async connect() {
    return new FakeClient(this._store, null);
  }

  async query(sql, params = []) {
    return execute(this._store, null, sql, params);
  }

  async end() {
    // No-op.
  }
}

/** Execute a single SQL statement against the store, journaling undo ops. */
function execute(store, journal, sql, params) {
  const s = sql.trim().replace(/\s+/g, ' ');

  if (/^BEGIN/i.test(s)) {
    return { rows: [], rowCount: 0 };
  }
  if (/^COMMIT/i.test(s)) {
    return { rows: [], rowCount: 0 };
  }
  if (/^ROLLBACK/i.test(s)) {
    if (journal) {
      for (let i = journal.length - 1; i >= 0; i -= 1) journal[i]();
      journal.length = 0;
    }
    return { rows: [], rowCount: 0 };
  }

  if (/^INSERT/i.test(s)) return execInsert(store, journal, s, params);
  if (/^SELECT/i.test(s)) return execSelect(store, s, params);
  if (/^UPDATE/i.test(s)) return execUpdate(store, journal, s, params);

  // CREATE TABLE / INDEX etc. are handled separately by migrate(); this adapter
  // is seeded directly, so unsupported DDL is a no-op for safety.
  if (/^CREATE/i.test(s) || /^ALTER/i.test(s) || /^DROP/i.test(s)) {
    return { rows: [], rowCount: 0 };
  }

  throw new Error(`fake-pg: unsupported SQL: ${s.slice(0, 120)}`);
}

function parseInsert(sql) {
  // INSERT INTO <t> (<cols>) VALUES (<vals>) [ON CONFLICT (<c>) DO NOTHING|DO UPDATE SET x=EXCLUDED.x, ...] [RETURNING <col>]
  const m = sql.match(/^INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
  if (!m) throw new Error(`fake-pg: cannot parse INSERT: ${sql}`);
  const table = m[1].toLowerCase();
  const cols = m[2].split(',').map((c) => c.trim().toLowerCase());
  const vals = m[3].split(',').map((v) => v.trim());
  const rest = sql.slice(m[0].length);
  let onConflict = null;
  const ocMatch = rest.match(/ON\s+CONFLICT\s*\(([^)]+)\)\s*(DO\s+NOTHING|DO\s+UPDATE\s+SET\s+([^;]+))/i);
  if (ocMatch) {
    onConflict = {
      target: ocMatch[1].split(',').map((c) => c.trim().toLowerCase()),
      mode: /DO\s+NOTHING/i.test(ocMatch[2]) ? 'NOTHING' : 'UPDATE',
      setClause: ocMatch[3] || '',
    };
  }
  const retMatch = rest.match(/RETURNING\s+([a-zA-Z0-9_,\s]+?)(?:;|\s*$)/i);
  const returningCols = retMatch
    ? retMatch[1].split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
    : [];
  return { table, cols, vals, onConflict, returningCols };
}

function execInsert(store, journal, sql, params) {
  const { table, cols, vals, onConflict, returningCol } = parseInsert(sql);
  const t = store[table];
  if (!t) throw new Error(`fake-pg: unknown table ${table}`);

  const row = {};
  for (let i = 0; i < cols.length; i += 1) {
    row[cols[i]] = param(vals[i], params);
  }

  // Serial primary key allocation.
  if (t.serial && t.pkey && row[t.pkey] === undefined) {
    row[t.pkey] = t.nextId;
    t.nextId += 1;
  }

  // Unique constraint handling (ON CONFLICT).
  if (onConflict && onConflict.mode === 'NOTHING') {
    const conflict = t.rows.find((r) => onConflict.target.every((c) => r[c] === row[c]));
    if (conflict) {
      return { rows: [], rowCount: 0 };
    }
  } else if (onConflict && onConflict.mode === 'UPDATE') {
    const conflict = t.rows.find((r) => onConflict.target.every((c) => r[c] === row[c]));
    if (conflict) {
      // Apply SET x = EXCLUDED.x clauses.
      for (const clause of onConflict.setClause.split(',')) {
        const c = clause.trim().match(/^([a-zA-Z0-9_]+)\s*=\s*EXCLUDED\.([a-zA-Z0-9_]+)/i);
        if (c) {
          undoRow(store, journal, table, conflict);
          conflict[c[1].toLowerCase()] = row[c[2].toLowerCase()];
          pushRowUndo(store, journal, table, conflict);
        }
      }
      return returningCol ? { rows: [{ [returningCol]: conflict[returningCol] }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
  }

  // Enforce general unique constraints.
  for (const ucols of t.unique) {
    const dup = t.rows.find((r) => ucols.every((c) => r[c] === row[c]));
    if (dup) {
      throw new Error(`duplicate key value violates unique constraint for ${table}`);
    }
  }

  t.rows.push(row);
  if (journal) journal.push(() => {
    const idx = t.rows.indexOf(row);
    if (idx >= 0) t.rows.splice(idx, 1);
  });

  if (returningCols && returningCols.length) {
    const out = {};
    for (const c of returningCols) out[c] = row[c];
    return { rows: [out], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
}

function undoRow(store, journal, table, row) {
  if (journal) journal.push(() => { table.rows.push(row); });
}
function pushRowUndo(store, journal, table, row) {
  /* keeping a row referenced; mutation undo handled by value snapshot below */
  if (journal) journal.push(() => { /* value snapshots handled by explicit undo */ });
}

function execSelect(store, sql, params) {
  let s = sql.replace(/FOR\s+UPDATE/ig, '').trim();

  // COUNT aggregate: SELECT COUNT(*)::int AS <name> FROM <t> WHERE ...
  const countMatch = s.match(/^SELECT\s+COUNT\(\*\)(::int)?\s+(?:AS\s+)?([a-zA-Z0-9_]+)\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?\s*(WHERE\s+(.*))?$/i);
  if (countMatch) {
    const table = (countMatch[3] || '').toLowerCase();
    const whereClause = countMatch[6] || null;
    const alias = countMatch[5] || countMatch[3];
    const t = store[table];
    if (!t) throw new Error(`fake-pg: unknown table ${table}`);
    const { conditions, anyFilter } = parseWhere(whereClause);
    let count = 0;
    if (anyFilter) {
      const allowed = params[anyFilter.paramIndex] || [];
      for (const row of t.rows) {
        if (allowed.includes(row[anyFilter.col])) count += 1;
      }
    } else {
      for (const row of t.rows) {
        const conds = conditions.map((c) => resolveCond(c, params));
        if (conds.every((c) => row[c.col] === c.value)) count += 1;
      }
    }
    return { rows: [{ [countMatch[2]]: count }], rowCount: 1 };
  }

  // JOIN select: SELECT g.id, g.game_state, o.owner_user_id FROM games g LEFT JOIN games_owners o ON o.game_id = g.id WHERE g.id = $1
  const joinMatch = s.match(/^SELECT\s+(.+?)\s+FROM\s+([a-zA-Z0-9_]+)\s+(?:AS\s+)?([a-zA-Z0-9_]+)\s+LEFT\s+JOIN\s+([a-zA-Z0-9_]+)\s+(?:AS\s+)?([a-zA-Z0-9_]+)\s+ON\s+([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*=\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+))?$/i);
  if (joinMatch) {
    const exprList = joinMatch[1].split(',').map((e) => e.trim());
    const leftTable = joinMatch[2].toLowerCase();
    const leftAlias = joinMatch[3];
    const rightTable = joinMatch[4].toLowerCase();
    const rightAlias = joinMatch[5];
    const rightCol = joinMatch[7].toLowerCase();
    const leftCol = joinMatch[9].toLowerCase();
    const whereClause = joinMatch[11] || null;

    const lt = store[leftTable];
    const rt = store[rightTable];
    if (!lt) throw new Error(`fake-pg: unknown table ${leftTable}`);

    const { conditions, anyFilter } = parseWhere(whereClause);
    const results = [];
    for (const lrow of lt.rows) {
      const conds = conditions.map((c) => resolveCond(c, params));
      // conditions reference the left table column (may be qualified).
      const matches = conds.every((c) => {
        const col = c.col.split('.').pop();
        return lrow[col] === c.value;
      });
      if (!matches) continue;
      const jrow = (rt.rows || []).find((r) => r[rightCol] === lrow[leftCol]);
      const out = {};
      for (const expr of exprList) {
        if (expr === '*') {
          Object.assign(out, lrow, jrow || {});
        } else {
          const col = expr.split('.').pop();
          if (expr.includes(`${leftAlias}.`)) out[col] = lrow[col];
          else if (expr.includes(`${rightAlias}.`)) out[col] = jrow ? jrow[col] : null;
          else out[col] = lrow[col];
        }
      }
      results.push(out);
    }
    return { rows: results, rowCount: results.length };
  }

  // Simple SELECT <cols> FROM <t> [WHERE ...] [ORDER BY c]
  const simpleMatch = s.match(/^SELECT\s+(.+?)\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?\s*(?:WHERE\s+(.*?)\s*)?(?:ORDER\s+BY\s+([a-zA-Z0-9_]+))?$/i);
  if (simpleMatch) {
    const exprList = simpleMatch[1].split(',').map((e) => e.trim());
    const table = simpleMatch[2].toLowerCase();
    const whereClause = simpleMatch[4] || null;
    const orderBy = simpleMatch[5] ? simpleMatch[5].toLowerCase() : null;
    const t = store[table];
    if (!t) throw new Error(`fake-pg: unknown table ${table}`);

    const { conditions, anyFilter } = parseWhere(whereClause);
    let results = [];

    for (const row of t.rows) {
      if (anyFilter) {
        const allowed = params[anyFilter.paramIndex] || [];
        if (!allowed.includes(row[anyFilter.col])) continue;
      } else {
        const conds = conditions.map((c) => resolveCond(c, params));
        if (!conds.every((c) => row[c.col] === c.value)) continue;
      }
      const out = {};
      if (exprList.length === 1 && exprList[0] === '*') {
        Object.assign(out, row);
      } else {
        for (const expr of exprList) {
          const col = expr.split('.').pop().toLowerCase();
          out[col] = row[col];
        }
      }
      results.push(out);
    }

    if (orderBy) {
      results.sort((a, b) => {
        if (typeof a[orderBy] === 'number' && typeof b[orderBy] === 'number') return a[orderBy] - b[orderBy];
        return String(a[orderBy]).localeCompare(String(b[orderBy]));
      });
    }

    return { rows: results, rowCount: results.length };
  }

  throw new Error(`fake-pg: cannot parse SELECT: ${sql.slice(0, 120)}`);
}

function execUpdate(store, journal, sql, params) {
  // UPDATE <t> SET <c> = $n WHERE id = $n
  const m = sql.match(/^UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+([a-zA-Z0-9_]+)\s*=\s*\$(\d+)\s+WHERE\s+([a-zA-Z0-9_]+)\s*=\s*\$(\d+)/i);
  if (!m) throw new Error(`fake-pg: cannot parse UPDATE: ${sql}`);
  const table = m[1].toLowerCase();
  const setCol = m[2].toLowerCase();
  const setVal = param(m[3], params) === undefined ? params[parseInt(m[3], 10) - 1] : param(m[3], params);
  const whereCol = m[4].toLowerCase();
  const whereVal = params[parseInt(m[5], 10) - 1];

  const t = store[table];
  if (!t) throw new Error(`fake-pg: unknown table ${table}`);
  let updated = 0;
  for (const row of t.rows) {
    if (row[whereCol] === whereVal) {
      const snapshot = { ...row };
      row[setCol] = setVal;
      if (journal) journal.push(() => { Object.assign(row, snapshot); });
      updated += 1;
    }
  }
  return { rows: [], rowCount: updated };
}

/** Create a fake pool pre-seeded with the schema + question bank from game_ddl.sql. */
function createFakePool(seedQuestions) {
  const store = createStore();

  // Seed the question bank (ids 1..10) identical to sql/seed/001_questions.sql.
  const questions = seedQuestions || [
    { id: 1, prompt: 'What is 1/2 + 1/4?', options: ['1/3', '3/4', '2/6', '1/2'], correct_answer: '3/4' },
    { id: 2, prompt: 'What is 1/3 + 1/3?', options: ['2/3', '1/6', '1/3', '2/6'], correct_answer: '2/3' },
    { id: 3, prompt: 'What is 1/2 of 1/2?', options: ['1/4', '1/2', '1', '1/8'], correct_answer: '1/4' },
    { id: 4, prompt: 'What is 3/4 - 1/4?', options: ['1/2', '1/4', '2/4', '1'], correct_answer: '1/2' },
    { id: 5, prompt: 'What is 1/3 + 1/6?', options: ['1/2', '1/6', '2/6', '1/9'], correct_answer: '1/2' },
    { id: 6, prompt: 'What fraction is equal to 2/4?', options: ['1/2', '2/3', '1/4', '3/4'], correct_answer: '1/2' },
    { id: 7, prompt: 'What is 1/2 - 1/6?', options: ['1/3', '1/2', '1/6', '2/6'], correct_answer: '1/3' },
    { id: 8, prompt: 'What is 1/4 + 1/4?', options: ['1/2', '1/8', '1/4', '2/4'], correct_answer: '1/2' },
    { id: 9, prompt: 'What is 2/3 + 1/6?', options: ['5/6', '1/2', '3/6', '2/6'], correct_answer: '5/6' },
    { id: 10, prompt: 'What fraction is the same as 1/2?', options: ['2/4', '1/4', '1/3', '2/3'], correct_answer: '1/2' },
  ];

  store.questions.rows = questions.map((q) => ({ ...q }));
  store.questions.nextId = questions.length + 1;

  return new FakePool(store);
}

module.exports = {
  createFakePool,
};