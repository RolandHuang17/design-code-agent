-- Space Fractions — schema migration 001
--
-- PostgreSQL 16 source-of-truth schema. The original design (Architecture
-- Documentation lines 118-124) defines:
--
--   CREATE TABLE games (
--     id SERIAL PRIMARY KEY,
--     game_state JSONB NOT NULL
--   );
--
-- The operator supplement (space-fractions.md lines 47-50) requires normalized
-- ownership of game state: "PostgreSQL must own all game state; map verified
-- sub strings to numeric internal user IDs." The 'games' table name is kept,
-- and the JSONB game_state is expanded into normalized child tables
-- (game_questions, answers) while preserving the canonical 'games' identifier.
--
-- Contracts (space-fractions.md line 48):
--   - games(id, owner_id, state, score)
--   - unique(users.subject)  -- one internal user per OIDC subject
--   - unique answers(game_id, question_id)  -- dedup per game
--
-- This file is idempotent: it uses CREATE TABLE IF NOT EXISTS and idempotent
-- index creation so the migration runner may replay it safely.

BEGIN;

-- ---------------------------------------------------------------------------
-- Users — verified OIDC subjects mapped to numeric internal IDs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  subject     TEXT NOT NULL,
  profile     TEXT NOT NULL DEFAULT '',
  roles       TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_subject_key
  ON users (subject);

-- ---------------------------------------------------------------------------
-- Questions — six-grade fraction prompts with an exact rational correct
-- answer. options is a JSON array of strings; correct_answer is a single
-- fraction in canonical "a/b" (or integer) form accepted by the shared
-- fraction validator.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
  id             SERIAL PRIMARY KEY,
  prompt         TEXT NOT NULL,
  options        JSONB NOT NULL DEFAULT '[]',
  correct_answer TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Games — preserves the original 'games' table name. game_state JSONB is
-- retained for original-design compatibility (intro/menu/play phase state),
-- while ownership and score are promoted to typed columns for authorization
-- and transactional scoring.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
  id         SERIAL PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'in_progress'
             CHECK (state IN ('in_progress', 'paused', 'finished')),
  score      INTEGER NOT NULL DEFAULT 0,
  game_state JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS games_owner_idx ON games (owner_id);

-- ---------------------------------------------------------------------------
-- game_questions — the ordered set of questions composing a game. position
-- guarantees a stable question order (assumption noted in plan).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_questions (
  game_id     INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (game_id, question_id)
);

CREATE INDEX IF NOT EXISTS game_questions_position_idx
  ON game_questions (game_id, position);

-- ---------------------------------------------------------------------------
-- answers — submitted answers. The UNIQUE (game_id, question_id) constraint
-- deduplicates repeats in the same transaction, preventing double scoring.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answers (
  id          SERIAL PRIMARY KEY,
  game_id     INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  answer      TEXT NOT NULL,
  correct     BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, question_id)
);

COMMIT;