-- Space Fractions: Initial Schema
-- Creates tables: users, questions, games, game_answers

BEGIN;

-- Users table: maps OIDC subject to internal user ID
CREATE TABLE IF NOT EXISTS users (
    id          SERIAL PRIMARY KEY,
    sub         TEXT NOT NULL UNIQUE,        -- OIDC 'sub' claim
    username    TEXT NOT NULL,
    email       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_sub ON users (sub);

-- Questions table: stores fraction questions with multiple-choice options
CREATE TABLE IF NOT EXISTS questions (
    id              SERIAL PRIMARY KEY,
    prompt          TEXT NOT NULL,
    options         JSONB NOT NULL,         -- Array of strings, e.g. ["1/2","3/4","5/8","2/3"]
    correct_answer  TEXT NOT NULL,          -- The correct fraction string, e.g. "3/4"
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions (created_at);

-- Games table: tracks game sessions
-- state: 'playing', 'paused', 'completed'
CREATE TABLE IF NOT EXISTS games (
    id                      SERIAL PRIMARY KEY,
    user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state                   TEXT NOT NULL DEFAULT 'playing'
                            CHECK (state IN ('playing', 'paused', 'completed')),
    score                   INTEGER NOT NULL DEFAULT 0,
    question_ids            INTEGER[] NOT NULL,
    current_question_index  INTEGER NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_games_user_id ON games (user_id);
CREATE INDEX IF NOT EXISTS idx_games_state ON games (state);

-- Game answers: tracks per-question answers for score deduplication
CREATE TABLE IF NOT EXISTS game_answers (
    id          SERIAL PRIMARY KEY,
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    answer      TEXT NOT NULL,
    correct     BOOLEAN NOT NULL,
    scored      BOOLEAN NOT NULL DEFAULT FALSE,  -- Whether score was incremented for this answer
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (game_id, question_id)                -- One answer row per question per game
);

CREATE INDEX IF NOT EXISTS idx_game_answers_game_id ON game_answers (game_id);

COMMIT;