-- Idempotent PostgreSQL16 schema and seed for the library borrowing gateway.
-- Safe to run on every startup: tables and indexes are created if absent, and
-- seed rows are inserted only when the tables are empty, so repeated startup
-- never overwrites user-created books.

BEGIN;

CREATE TABLE IF NOT EXISTS books (
    id               BIGSERIAL PRIMARY KEY,
    title            TEXT NOT NULL,
    copies           INTEGER NOT NULL CHECK (copies >= 0),
    "availableCopies" INTEGER NOT NULL CHECK ("availableCopies" >= 0),
    CHECK ("availableCopies" <= copies)
);

CREATE TABLE IF NOT EXISTS loans (
    id          BIGSERIAL PRIMARY KEY,
    "bookId"    BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    "userId"    TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('active', 'returned')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    returned_at TIMESTAMPTZ
);

-- One active loan per (bookId, userId). Postgres allows multiple NULLs in a
-- partial unique index, so `returned` loans do not block future borrows.
CREATE UNIQUE INDEX IF NOT EXISTS loans_active_unique
    ON loans ("bookId", "userId")
    WHERE status = 'active';

-- Look up loans for a particular book (borrow validation) and list all loans.
CREATE INDEX IF NOT EXISTS loans_book_idx ON loans ("bookId");
CREATE INDEX IF NOT EXISTS loans_user_idx ON loans ("userId");

-- Idempotent seed: only when both tables are empty. Never inserts on repeated
-- startup, so user-created books and loans are preserved.
DO $$
BEGIN
    IF (SELECT count(*) FROM books) = 0 AND (SELECT count(*) FROM loans) = 0 THEN
        INSERT INTO books (title, copies, "availableCopies") VALUES
            ('The Great Gatsby', 2, 2),
            ('Moby-Dick', 1, 1),
            ('Pride and Prejudice', 3, 3);
    END IF;
END
$$;

COMMIT;