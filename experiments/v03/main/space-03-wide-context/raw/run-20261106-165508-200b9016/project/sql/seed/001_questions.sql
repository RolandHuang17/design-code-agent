-- Space Fractions question-bank seed (idempotent).
--
-- This file populates the `questions` table defined in sql/game_ddl.sql and
-- applied via sql/migrations/001_init.sql. It must be run after the schema
-- exists; repeated execution is safe because every insert uses
-- ON CONFLICT DO NOTHING on the primary key, so running it twice is a no-op.
--
-- Contract honored (space-fractions.md lines 41-49):
--   * Every correct_answer is a single reduced fraction (a/b with a positive
--     denominator and gcd(|a|, b) = 1, or a whole number denoting n/1) and is
--     therefore accepted by parseFraction()/fromParts() in lib/fraction.js.
--   * Stable question order: explicit integer ids give deterministic ordering.
--   * No EXCLUDED in a RETURNING clause anywhere (PG16 forbids it).
--
-- Verified fractions:
--   3/4, 2/3, 1/4, 1/2, 1/3, 5/6  -> all reduced (gcd = 1).
--   1    -> whole number, canonical form 1/1, accepted by the validator.

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

-- Keep the questions.id SERIAL sequence ahead of the explicit seed ids so a
-- later administrator-created question never collides with a seeded primary key.
SELECT setval(
  pg_get_serial_sequence('questions', 'id'),
  COALESCE((SELECT MAX(id) FROM questions), 0),
  (EXISTS (SELECT 1 FROM questions))
);