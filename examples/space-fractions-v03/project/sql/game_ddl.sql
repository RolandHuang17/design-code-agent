-- Space Fractions — game DDL extract
--
-- Standalone reference DDL for the game-domain tables. This is the same
-- normalized schema as sql/migrations/001_schema.sql, extracted for tooling
-- and manual inspection. Keep it in sync with the migration.
--
-- The original design (Architecture_Documentation.md lines 118-124) defined:
--
--   CREATE TABLE games (
--     id SERIAL PRIMARY KEY,
--     game_state JSONB NOT NULL
--   );
--
-- The operator supplement (space-fractions.md lines 47-50) requires PostgreSQL
-- to own all game state, mapping verified OIDC subjects to numeric internal
-- user IDs. The canonical 'games' table name is preserved; the opaque
-- game_state JSONB is retained for original-design compatibility while
-- ownership, lifecycle state and score are promoted to typed columns.
--
-- Contract (space-fractions.md line 48):
--   - games(id, owner_id, state, score)
--   - unique(users.subject)
--   - unique answers(game_id, question_id) for dedup
--
-- Idempotent: CREATE ... IF NOT EXISTS so the file may be replayed safely.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  subject     TEXT NOT NULL,
  profile     TEXT NOT NULL DEFAULT '',
  roles       TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_subject_key ON users (subject);

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

CREATE TABLE IF NOT EXISTS questions (
  id             SERIAL PRIMARY KEY,
  prompt         TEXT NOT NULL,
  options        JSONB NOT NULL DEFAULT '[]',
  correct_answer TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_questions (
  game_id     INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (game_id, question_id)
);
CREATE INDEX IF NOT EXISTS game_questions_position_idx
  ON game_questions (game_id, position);

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