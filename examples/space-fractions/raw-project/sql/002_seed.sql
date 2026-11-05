-- Space Fractions: Seed Data
-- Idempotent: uses ON CONFLICT DO NOTHING to avoid duplicates on re-run.
-- Depends on: 001_initial.sql

BEGIN;

-- Seed admin user (sub matches Keycloak admin user from realm.json)
INSERT INTO users (sub, username, email)
VALUES ('admin-user-sub', 'admin', 'admin@spacefractions.local')
ON CONFLICT (sub) DO NOTHING;

-- Seed student user
INSERT INTO users (sub, username, email)
VALUES ('student-user-sub', 'student', 'student@spacefractions.local')
ON CONFLICT (sub) DO NOTHING;

-- Get the admin user ID for foreign key
DO $$
DECLARE
    admin_id INTEGER;
BEGIN
    SELECT id INTO admin_id FROM users WHERE sub = 'admin-user-sub';

    -- Seed fraction questions (6th-grade level)
    INSERT INTO questions (prompt, options, correct_answer, created_by) VALUES
    (
        'What is 1/2 + 1/4?',
        '["1/6", "3/4", "2/6", "1/8"]',
        '3/4',
        admin_id
    ),
    (
        'What is 3/5 - 1/5?',
        '["2/5", "4/5", "1/5", "3/10"]',
        '2/5',
        admin_id
    ),
    (
        'What is 2/3 × 3/4?',
        '["6/12", "5/7", "1/2", "2/4"]',
        '1/2',
        admin_id
    ),
    (
        'What is 3/4 ÷ 1/2?',
        '["3/8", "6/4", "3/2", "1/2"]',
        '3/2',
        admin_id
    ),
    (
        'Which fraction is equivalent to 2/3?',
        '["4/6", "3/4", "1/3", "5/8"]',
        '4/6',
        admin_id
    ),
    (
        'What is 5/6 - 1/3?',
        '["4/3", "1/2", "3/6", "4/6"]',
        '1/2',
        admin_id
    ),
    (
        'What is 1/4 + 3/8?',
        '["4/12", "5/8", "3/4", "1/2"]',
        '5/8',
        admin_id
    ),
    (
        'Order from least to greatest: 1/2, 1/4, 3/4',
        '["1/2, 1/4, 3/4", "1/4, 1/2, 3/4", "3/4, 1/2, 1/4", "1/4, 3/4, 1/2"]',
        '1/4, 1/2, 3/4',
        admin_id
    ),
    (
        'What is 7/8 - 1/4?',
        '["6/4", "5/8", "3/4", "6/8"]',
        '5/8',
        admin_id
    ),
    (
        'A pizza has 8 slices. You eat 3. What fraction remains?',
        '["3/8", "5/8", "1/2", "8/3"]',
        '5/8',
        admin_id
    )
    ON CONFLICT DO NOTHING;

END $$;

COMMIT;