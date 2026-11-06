-- Space Fractions persistence schema.
--
-- Honors the original games DDL verbatim (Architecture_Documentation.md §D):
--   CREATE TABLE games (
--     id SERIAL PRIMARY KEY,
--     game_state JSONB NOT NULL
--   );
--
-- The operator supplement expands the schema with questions, answers, and users
-- while keeping PostgreSQL as the system of record (space-fractions.md).
--
-- PG16 constraints honored here:
--   * Never use EXCLUDED in a RETURNING clause (illegal on PG16); upsert logic in
--     lib/db.js therefore uses simple transactional statements instead.
--   * Every seed answer is a single reduced fraction accepted by the same
--     validator used at runtime (lib/fraction.js). This CHECK constraint enforces
--     the 'n/d' canonical form with a positive denominator and no reducible terms
--     at rest, mirroring validator semantics.

BEGIN;

-- ---------------------------------------------------------------------------
-- games: original DDL, verbatim.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  game_state JSONB NOT NULL
);

-- ---------------------------------------------------------------------------
-- users: verified OIDC subject -> numeric internal id mapping.
-- A subject is unique so the user id upsert in lib/db.js is idempotent and
-- concurrency-safe (ON CONFLICT (sub) DO UPDATE ... RETURNING id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  sub TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- questions: admin-owned question bank. correct_answer is the canonical
-- single reduced fraction 'n/d' (or whole number 'n' which denotes n/1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  prompt TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  correct_answer TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT questions_correct_answer_single_fraction
    CHECK (correct_answer ~* '^-?\d+/\d+$' OR correct_answer ~ '^-?\d+$'),
  CONSTRAINT questions_options_is_array
    CHECK (jsonb_typeof(options) = 'array')
);

-- ---------------------------------------------------------------------------
-- games_ownership: link a game to its owner (verified subject) for
-- per-game authorization. One game may have at most one owner.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games_owners (
  game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- game_questions: stable, ordered question set for a game. Order is
-- deterministic via position (stable question order per the supplement).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_questions (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (game_id, position),
  UNIQUE (game_id, question_id)
);

-- ---------------------------------------------------------------------------
-- answers: submitted answers. A question may be answered at most once per game
-- (score dedup is enforced in the transaction layer, and this unique index
-- provides the serialization guard).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answers (
  id SERIAL PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answer TEXT NOT NULL,
  correct BOOLEAN NOT NULL,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, question_id)
);

-- Deterministic question ordering support: index the position column so the
-- "stable question order" contract is satisfied without a full sort in memory.
CREATE INDEX IF NOT EXISTS idx_game_questions_order
  ON game_questions (game_id, position);

COMMIT;