# Library Borrowing

A local browser application for a small library. Users list books and available
copies, borrow a book using an explicitly entered reader ID, and return a loan.
The frontend provides clear success/error feedback.

Reader IDs are demonstration inputs entered by the caller — **they are not
authenticated identities**. This is a local learning demonstration; no OAuth or
other authentication is implemented (and none is required).

## Stack

- Node.js 22 + Express gateway (one deployable service containing the `catalog`
  and `loans` business modules).
- PostgreSQL 16 (persistence for books and loans).
- Plain HTML/CSS/JavaScript frontend served from `public/` at `/`.

The architecture is documented in `architecture-decisions.md`; the REST contract
is in `openapi.yaml`.

## Quick start (Docker Compose)

```bash
docker compose up --build
```

This starts two services:

- `postgres` — container port 5432.
- `gateway` — container port 3000, serving the browser UI at `/` and `GET /health`.

Open http://localhost:3000 to use the application. The schema is created
idempotently on startup and seeded **only when the books table is empty**, so a
restart never overwrites books you created.

## Running locally (without Compose)

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Start a PostgreSQL instance and export connection variables (defaults in
   `src/server.js` target `postgres`/`library`):

   ```bash
   export PGHOST=localhost PGPORT=5432 PGUSER=library PGPASSWORD=library PGDATABASE=library
   npm start
   ```

3. Open http://localhost:3000.

See `.env.example` for the full list of environment variables.

## API

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/health` | 200 | — |
| GET | `/` | browser UI | — |
| POST | `/api/books` `{title,copies}` | 201 `{id,title,availableCopies}` | 400 invalid |
| GET | `/api/books` | 200 `{books:[...]}` | — |
| GET | `/api/books/:id` | 200 `{id,title,availableCopies}` | 404 unknown |
| POST | `/api/loans` `{bookId,userId}` | 201 `{id,bookId,userId,status:"active"}` | 400/404/409 |
| GET | `/api/loans` | 200 `{loans:[...]}` | — |
| POST | `/api/loans/:id/return` | 200 `status:"returned"` (idempotent) | 400/404 |

Business rules: copies cannot go negative; no remaining stock → 409; one active
loan per `(bookId,userId)` → 409 on duplicate; invalid title/copies or missing IDs
→ 400. Returns are idempotent — repeating a return does not increment stock again.

## Scripts

| Command | Purpose |
|---|---|
| `npm test` | Runs unit + API tests against the **in-memory** repository adapter. No live PostgreSQL required. |
| `npm run build` | Actually checks sources with `node --check` across `src/`. |
| `npm start` | Starts the gateway (`src/server.js`) against PostgreSQL. |

## Tests vs. runtime acceptance

- **`npm test` (fake infrastructure)** — business logic, validation, and the
  single-copy concurrency invariants are exercised against the in-memory
  repository (`src/memoryRepository.js`). This runs with no PostgreSQL, Redis, or
  identity provider.
- **Real runtime acceptance** — the PostgreSQL transaction/row-lock behavior
  (including the eight-borrower single-copy scenario) is exercised by bringing up
  the full stack with `docker compose up` and hitting the real gateway. This is
  the authoritative check for persistence and concurrency; `npm test` verifies
  the same invariants through a deterministic in-memory adapter.

## Project layout

```
src/
  server.js          gateway entrypoint (pool, bootstrap, static UI, /health)
  app.js             Express app factory createApp(repository)
  catalog.js         catalog business module
  loans.js           loans business module (borrow/return)
  repository.js      repository interface
  pgRepository.js    PostgreSQL adapter
  memoryRepository.js  in-memory adapter (tests only)
  schema.js          idempotent schema bootstrap + seed
public/              plain HTML/CSS/JS frontend
test/                unit + API tests (in-memory repository)
```

## Configuration

All runtime configuration is environment-driven (see `.env.example`). The gateway
uses `PUBLIC_ORIGIN` only if browser redirects are ever needed; this local demo
does not use redirects. No secrets are committed.