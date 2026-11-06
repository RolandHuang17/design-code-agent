# Architecture decisions

These decisions implement the library borrowing design. Original requirements are
attributed to `Architecture_Documentation.md` and `Architecture_View.md`; items added
by the operator supplement come from `library.md` (marked as such). Derived decisions
with no explicit source are labeled **assumption**.

## 1. Single deployable gateway with two business modules

The design requires "Catalog and loan management are separate business modules inside
one deployable gateway service" (Architecture_Documentation.md, L14). We implement two
cohesive modules, `src/catalog.js` and `src/loans.js`, wired into one Express app
(`src/app.js`), served by one gateway process. No microservices, message queue, or
search engine (all explicitly out of scope).

## 2. Repository abstraction with dependency injection

To keep `npm test` runnable without a live PostgreSQL or Redis, all business modules
depend on a repository interface (`src/repository.js`). Two adapters implement it:

- `src/pgRepository.js` — real PostgreSQL via `pg`, used at runtime.
- `src/memoryRepository.js` — test-only in-memory adapter.

The Express app is a factory `createApp(repository)`. `npm test` injects the in-memory
adapter; the protected runtime acceptance exercises the real PostgreSQL path via
Docker Compose. This satisfies "Distinguish tests using fake infrastructure from real
runtime acceptance" (Architecture_Documentation.md, L27).

## 3. Concurrency and inventory integrity

Borrowing and returning mutate inventory under a PostgreSQL transaction with a row lock
on the book row (`SELECT ... FOR UPDATE`), matching the borrow sequence diagram
(Architecture_View.md, L22–42) and NFR1 (eight simultaneous borrowers of a single copy
yield exactly one loan; inventory never negative).

- **Borrow**: begin transaction, lock the book row, verify remaining copies > 0 and no
  active loan for `(bookId, userId)`; insert the loan and decrement
  `available_copies`; commit. Insufficient stock or duplicate active loan rolls back and
  maps to HTTP 409 (Architecture_Documentation.md, FR3/FR5).
- **Return**: transition `active` → `returned` and increment stock atomically; a repeat
  return is idempotent and does not increment stock again (loan state diagram,
  Architecture_View.md, L44–51).

The in-memory adapter mirrors this semantics with a synchronous single-threaded
transaction model so unit tests can verify single-copy concurrency deterministically.

## 4. Data model

Two tables, both created idempotently with `CREATE TABLE IF NOT EXISTS`:

- `books(id, title, total_copies, available_copies)`.
- `loans(id, book_id, user_id, status)` with a unique partial index on
  `(book_id, user_id)` where `status = 'active'` to enforce FR3 at the database level.

`available_copies` is an integer column mutated in place under row lock. This is an
**assumption**: the design names "available copies" but not a storage representation;
a column is the simplest correct choice for this small case.

Bootstrap seeds demo books **only when the table is empty**, so repeated startups never
overwrite user-created books (Architecture_Documentation.md, L16).

## 5. Identifier generation

Book and loan IDs are auto-generated integers (`SERIAL`/identity). The REST interface
names only `id`, `title`, `availableCopies`, `bookId`, `userId`, `status`; the
generation mechanism is unspecified, so auto-increment is an **assumption**.

## 6. Reader identity

Reader IDs are demonstration inputs entered by the caller, not authenticated identities
(Architecture_Documentation.md, L3–5; library.md, L13). We deliberately do **not**
introduce OAuth or any authentication, per the explicit exclusion.

## 7. HTTP status contract

Fixed interface contract (supplement library.md, L9–14 and original L19–25):

| Endpoint | Success | Errors |
|---|---|---|
| `GET /health` | 200 | — |
| `POST /api/books` | 201 `{id,title,availableCopies}` | 400 invalid title/copies |
| `GET /api/books` | 200 `{books:[...]}` | — |
| `GET /api/books/:id` | 200 | 404 unknown, 400 malformed |
| `POST /api/loans` | 201 `{id,bookId,userId,status:"active"}` | 409 duplicate/insufficient, 400 malformed, 404 missing book |
| `GET /api/loans` | 200 `{loans:[...]}` | — |
| `POST /api/loans/:id/return` | 200 `{...,status:"returned"}`, idempotent | 404 missing loan, 400 malformed |

## 8. Verification strategy

- `npm test` (default) — unit + API tests against the in-memory adapter; no live
  PostgreSQL required.
- `npm run build` — actually checks sources (`node --check` across src).
- Runtime acceptance — Docker Compose brings up gateway + postgres and exercises the
  real PostgreSQL transaction/row-lock behavior including the eight-borrower scenario.

## 9. Dependencies and runtime

- Node.js 22 (required).
- `express` for HTTP, `pg` for PostgreSQL.
- Plain HTML/CSS/JavaScript frontend served from `public/` at `/` (no build step,
  no framework).
- PostgreSQL service pinned to `postgres:16` to satisfy NFR2 (original specifies 16;
  supplement does not override).