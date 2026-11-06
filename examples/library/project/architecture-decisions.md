# Architecture Decisions

These decisions derive from the input documents. Statements from the original
architecture documents are cited as *original*; anything introduced to make the
interface runnable or to satisfy the operator benchmark supplement is labeled as
an **assumption** and is not attributed to the original design.

## Context

- Original: `Architecture_Documentation.md` (library borrowing, FR1-FR5, NFR1-NFR2).
- Original: `Architecture_View.md` (component, borrow sequence, loan state diagrams).
- Supplement (operator-provided, *not* original): `library.md` fixed interface contract.

## ADR-1: Single deployable gateway with two business modules

**Original.** Catalog and Loans are separate business modules inside one
deployable gateway service. No OAuth, queue, search engine, or cloud deployment.
Decision: a single Express process exposes both modules under one API surface;
the browser talks HTTP REST to that gateway.

Implementation: `src/catalog/` and `src/loans/` are separate modules sharing one
store interface; `src/http/` wires them into Express routes.

## ADR-2: PostgreSQL16 persistence only, no in-memory fallback at runtime

**Original** (NFR2, Architecture and deployment). Books, stock and loans survive
restart using PostgreSQL16. **Supplement** reinforces: no in-memory persistence
when PostgreSQL is unavailable.

Decision: production startup uses `PostgresStore` exclusively and fails fast (no
silent memory fallback) if the database is unreachable.

**Assumption (ASM2).** The host requires `npm test` to run without a live
PostgreSQL, Redis, or identity provider. To reconcile this with "no in-memory at
runtime", the unit tests inject a test-only `InMemoryStore` adapter via
dependency injection. In-memory is never selected by the production
`src/server.js` path. This is dependency injection for testability, not a
runtime fallback.

## ADR-3: Transactions and row locks on a single client

**Original** (Architecture and deployment; borrow sequence diagram). Borrowing
and returning must use transactions and row locks on a single client.

Decision:

- **Borrow** (`POST /api/loans`): `BEGIN`; `SELECT ... FOR UPDATE` on the target
  book row; validate `availableCopies > 0` and absence of an active loan for the
  same `(bookId, userId)`; insert a loan with status `active`; decrement
  `availableCopies`; `COMMIT`. On exhausted stock or duplicate active loan,
  `ROLLBACK` and return `409`.
- **Return** (`POST /api/loans/:id/return`): within a transaction, lock the loan
  row, and only if its status is `active` transition to `returned` and increment
  `availableCopies` by exactly one. A repeated return finds status already
  `returned` and performs no stock change (idempotent `200`).

This matches the loan state machine: `Active -> Returned` (stock +1 atomically),
`Returned -> Returned` (repeated return, stock unchanged).

## ADR-4: Denormalized availableCopies for cheap reads

**Original** (REST: `availableCopies` in book payloads; FR2 "remaining copies").

**Assumption (ASM3).** Store both `copies` (total) and `availableCopies`
(currently borrowable) on the book row. Borrows decrement and returns increment
`availableCopies`. This keeps list/get reads simple while writes stay atomic
within a transaction.

## ADR-5: Idempotent schema bootstrap and seed

**Original.** "Bootstrap schema idempotently. Repeated startup must not
overwrite user-created books."

Decision: `schema.sql` uses `CREATE TABLE IF NOT EXISTS` plus idempotent index
creation. **Supplement** asks for idempotent seed; seeding occurs only when the
tables are empty and never on repeated startup, so user-created books are
preserved.

## ADR-6: REST contract and validation

**Original** (REST interface) and **Supplement** (fixed interface contract).
Status codes: `201` create book/loan, `200` list/get/return, `400` invalid
title/copies/identifiers, `404` unknown record, `409` insufficient copies or
duplicate active loan.

`title` must be a non-empty string; `copies` a positive integer; `bookId` and
`userId` non-empty identifiers. Validation is centralized in `src/http/validation.js`.

## ADR-7: Reader identity is demonstration input, not authentication

**Original** (FR: "Reader IDs are demonstration inputs, not authenticated
identities"). **Supplement** reinforces: "not a production authentication
design". Decision: `userId` is caller-provided and stored directly; no sessions,
tokens, or OAuth are implemented. `OIDC_ISSUER`/`OIDC_PUBLIC_ORIGIN` are merely
read/forwarded as gateway environment variables if present.

## ADR-8: Tooling and delivery

- Node.js 22, Express, `pg` for PostgreSQL (pinned dependencies; lockfile is
  host-generated via `npm install`/`npm ci`).
- `package.json` scripts: `test` (unit, no external DB), `build` (real source
  syntax check), `start` (production Postgres path), and a `healthcheck`
  script aliasing the `GET /health` behavior consumed by Compose/Dockerfile.
- Real database behavior is exercised by the protected runtime HTTP acceptance,
  separate from fake-infrastructure unit tests.