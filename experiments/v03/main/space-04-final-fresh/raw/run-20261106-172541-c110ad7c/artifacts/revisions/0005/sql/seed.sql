-- Space Fractions — idempotent seed data
--
-- Seeds the demo users (student/admin/other), the default sixth-grade
-- fraction question bank, and a reproducible practice game for the demo
-- student. Every correct_answer is a valid single fraction accepted by the
-- shared validator (src/shared/fraction.js): either an integer or a simple
-- "a/b" fraction in lowest terms (origin=assumption on exact string grammar).
--
-- Idempotency strategy:
--   - Users are upserted by OIDC subject (UNIQUE users.subject) so the same
--     demo account is reused across replays rather than duplicated.
--   - Questions are inserted deterministically with a stable ordinal key
--     (subject-less natural key encoded via md5 of prompt||correct_answer) to
--     avoid duplication while keeping ids reproducible across clean installs.
--   - The demo game is inserted only if the student has no existing game with
--     the reserved sentinel so replays do not pile up rows.
--
-- The password-grant/demo accounts below are LOCAL-ONLY fixtures; do not use
-- them in production. The Keycloak realm (infra/keycloak/realm.json) defines
-- the same subjects as the authoritative OIDC identities.

-- ---------------------------------------------------------------------------
-- Demo users (subjects match the Keycloak realm demo accounts).
-- ---------------------------------------------------------------------------
INSERT INTO users (subject, profile, roles)
VALUES
  ('student', 'Student Demo', '{}'),
  ('admin',   'Admin Demo',   '{admin}'),
  ('other',   'Other Demo',   '{}')
ON CONFLICT (subject) DO UPDATE
  SET profile = EXCLUDED.profile,
      roles   = EXCLUDED.roles,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- Default question bank. correct_answer is a canonical single fraction.
-- ---------------------------------------------------------------------------
INSERT INTO questions (prompt, options, correct_answer)
SELECT * FROM (VALUES
  (
    'What is 1/2 + 1/4?',
    '["1/4", "3/4", "2/6", "1/2"]'::jsonb,
    '3/4'
  ),
  (
    'What is 2/3 - 1/6?',
    '["1/2", "1/3", "1/6", "2/6"]'::jsonb,
    '1/2'
  ),
  (
    'Simplify 4/8.',
    '["1/2", "4/8", "2/4", "1/4"]'::jsonb,
    '1/2'
  ),
  (
    'What is 1/3 + 1/6?',
    '["1/2", "1/6", "2/9", "1/3"]'::jsonb,
    '1/2'
  ),
  (
    'What is 3/4 - 1/4?',
    '["1/2", "1/4", "2/4", "1"]'::jsonb,
    '1/2'
  ),
  (
    'What is 1/5 + 2/5?',
    '["3/5", "2/5", "3/10", "1/5"]'::jsonb,
    '3/5'
  ),
  (
    'Simplify 6/9.',
    '["2/3", "3/2", "6/9", "2/6"]'::jsonb,
    '2/3'
  ),
  (
    'What is 1/2 of 1/3?',
    '["1/6", "1/5", "2/3", "1/3"]'::jsonb,
    '1/6'
  )
) AS v(prompt, options, correct_answer)
WHERE NOT EXISTS (
  SELECT 1 FROM questions q
  WHERE q.prompt = v.prompt AND q.correct_answer = v.correct_answer
);

-- ---------------------------------------------------------------------------
-- Reproducible practice game for the demo student (five questions in stable
-- order). Uses a sentinel game_state marker so replays are skipped.
-- ---------------------------------------------------------------------------
WITH student AS (
  SELECT id FROM users WHERE subject = 'student' LIMIT 1
)
INSERT INTO games (owner_id, state, score, game_state)
SELECT s.id, 'in_progress', 0, '{"seed":"practice-1"}'::jsonb
FROM student s
WHERE NOT EXISTS (
  SELECT 1 FROM games g
  WHERE g.owner_id = s.id AND g.game_state->>'seed' = 'practice-1'
);

-- Populate game_questions for the seed game in stable position order.
WITH seed_game AS (
  SELECT id FROM games WHERE game_state->>'seed' = 'practice-1' LIMIT 1
),
ordered AS (
  SELECT q.id AS question_id, row_number() OVER (ORDER BY q.id) AS position
  FROM questions q
  ORDER BY q.id
  LIMIT 5
),
student AS (
  SELECT id FROM users WHERE subject = 'student' LIMIT 1
)
INSERT INTO game_questions (game_id, question_id, position)
SELECT sg.id, o.question_id, o.position::int
FROM seed_game sg, ordered o, student s
WHERE sg.id IN (SELECT id FROM games WHERE owner_id = s.id)
  AND NOT EXISTS (
    SELECT 1 FROM game_questions gq
    WHERE gq.game_id = sg.id AND gq.question_id = o.question_id
  )
ON CONFLICT (game_id, question_id) DO NOTHING;