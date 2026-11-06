-- Space Fractions migration 001: initial schema + idempotent seed data.
--
-- This migration is the canonical entrypoint run by lib/db.js against a fresh
-- PostgreSQL 16 database. It relies on sql/game_ddl.sql for the schema
-- (CREATE TABLE IF NOT EXISTS ...) so that repeated application is safe, and
-- then seeds the question bank idempotently (INSERT ... ON CONFLICT DO NOTHING).
--
-- Contracts honored (see space-fractions.md lines 41-49 and
-- Architecture_Documentation.md lines 118-124):
--   * games table: id SERIAL PRIMARY KEY, game_state JSONB NOT NULL (verbatim).
--   * Score updates serialized/deduped in one transaction (unique index on
--     answers(game_id, question_id) provides the guard; the transaction logic
--     lives in lib/db.js).
--   * No EXCLUDED in a RETURNING clause anywhere (not supported on PG16).
--   * Every seed answer is a single reduced fraction accepted by the same
--     validator used at runtime (lib/fraction.js).
--
-- Idempotency: the schema uses IF NOT EXISTS and the seed inserts use
-- ON CONFLICT DO NOTHING, so running this migration twice is a no-op.

\i ../game_ddl.sql

-- Seed question bank. Every correct_answer below is a single reduced fraction
-- and is accepted by parseFraction() in lib/fraction.js:
--   "1/2"   -> {1,2}
--   "3/4"   -> {3,4}
--   "2/3"   -> {2,3}
--   "1"     -> {1,1} (whole number form accepted as 1/1)
--   "5/6"   -> {5,6}
--   "1/3"   -> {1,3}
--
-- Deterministic insertion order; ON CONFLICT (id) DO NOTHING keeps this
-- idempotent. A stable natural key (prompt) would also be viable, but the
-- explicit integer ids below make the order and identities reproducible.

INSERT INTO questions (id, prompt, options, correct_answer) VALUES
  (1, 'What is 1/2 + 1/4?',
      '["1/3","3/4","2/6","1/2"]'::jsonb, '3/4'),
  (2, 'What is 1/3 + 1/3?',
      '["2/3","1/6","1/3","2/6"]'::jsonb, '2/3'),
  (3, 'What is 1/2 of 1/2?',
      '["1/4","1/2","1","1/8"]'::jsonb, '1/4'),
  (4, 'What is 3/4 - 1/4?',
      '["1/2","1/4","2/4","1"]'::jsonb, '1/2'),
  (5, 'What is 1/3 + 1/6?',
      '["1/2","1/6","2/6","1/9"]'::jsonb, '1/2'),
  (6, 'What fraction is equal to 2/4?',
      '["1/2","2/3","1/4","3/4"]'::jsonb, '1/2'),
  (7, 'What is 1/2 - 1/6?',
      '["1/3","1/2","1/6","2/6"]'::jsonb, '1/3'),
  (8, 'What is 1/4 + 1/4?',
      '["1/2","1/8","1/4","2/4"]'::jsonb, '1/2'),
  (9, 'What is 2/3 + 1/6?',
      '["5/6","1/2","3/6","2/6"]'::jsonb, '5/6'),
  (10, 'What fraction is the same as 1/2?',
      '["2/4","1/4","1/3","2/3"]'::jsonb, '1/2')
ON CONFLICT (id) DO NOTHING;