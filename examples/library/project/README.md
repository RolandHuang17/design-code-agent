# Library borrowing

A local browser application for a small library. A librarian creates titles with
a positive number of copies; readers (identified by caller-provided reader IDs)
see remaining copies, borrow an available book, and return loans. The UI gives
clear success/error feedback.

Reader IDs are **demonstration inputs, not authenticated identities** — there is
no OAuth or login. A reader holds at most one active loan per book; a different
reader may borrow another copy. Returns are idempotent and never increase stock
more than once.

## Stack

- **Node.js 22** + **Express** (CommonJS) for the gateway service.
- Plain **HTML/CSS/JavaScript** browser UI served at `/`.
- **PostgreSQL 16** for durable storage of books, stock, and loans.
- Two business modules — `Catalog` and `Loans` — share one deployable gateway
  service, as the design explicitly allows.

## Requirements (summary)

| ID | Requirement |
|----|-------------|
| FR1 | Create a title with a positive number of copies. |
| FR2 | Show remaining copies; borrow an available book. |
| FR3 | At most one active loan per (reader, book); other readers may borrow other copies. |
| FR4 | Returning a loan restores one copy; repeated/concurrent returns never over-increment. |
| FR5 | Invalid input → `400`; insufficient copies / duplicate active loan → `409`; missing record → `404`. |
| NFR1 | Eight simultaneous borrowers of a single copy → exactly one success; inventory never negative. |
| NFR2 | Books, stock, and loans survive restart (PostgreSQL persistence). |

Borrowing and returning run inside a **single-client transaction with row locks**
and commit/rollback as the sequence diagram describes.

## REST interface

| Method | Path | Success | Errors |
|--------|------|---------|--------|
| `POST` | `/api/books` `{title, copies}` | `201 {id, title, availableCopies}` | `400` invalid title/copies |
| `GET` | `/api/books` | `200 {books:[...]}` | — |
| `GET` | `/api/books/:id` | `200 {id, title, availableCopies}` | `404` unknown |
| `POST` | `/api/loans` `{bookId, userId}` | `201 {id, bookId, userId, status:"active"}` | `400` missing/invalid IDs, `409` no stock or duplicate active loan |
| `GET` | `/api/loans` | `200 {loans:[...]}` | — |
| `POST` | `/api/loans/:id/return` | `200 {..., status:"returned"}` (idempotent) | `404` unknown loan |
| `GET` | `/health` | `200` | — |

The full contract is documented in [`openapi.yaml`](openapi.yaml).

## Getting started

### With Docker Compose

```bash
docker compose up --build
```

This starts:

- `gateway` (container port **3000**) — API + UI, `GET /health`.
- `postgres` (container port **5432**, PostgreSQL 16).

Open <http://localhost:3000> (or your remapped public origin). The schema is
bootstrapped idempotently at startup; repeated startups never overwrite
user-created books or loans.

### Locally (without Docker)

Requires a running PostgreSQL 16 instance.

```bash
npm ci
npm run build      # real source check
npm test           # unit tests (no live PostgreSQL required)
npm start          # requires DATABASE_URL
```

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Listen port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://library:library@postgres:5432/library` |
| `PUBLIC_ORIGIN` | Browser-facing origin for redirects/URL construction | `http://localhost:3000` |
| `OIDC_ISSUER` | Identity-provider issuer URL (read/forwarded only) | *(empty)* |
| `OIDC_PUBLIC_ORIGIN` | Identity-provider public URL (read/forwarded only) | *(empty)* |

`PUBLIC_ORIGIN` and the `OIDC_*` values are read and forwarded as gateway
public-URL configuration. No OAuth flow consumes them in this demonstration.
See [`.env.example`](.env.example) for placeholders.

> **Persistence note:** production (`npm start` / Docker) always uses
> PostgreSQL and never falls back to in-memory storage. The in-memory adapter
> exists only as a test double injected by the unit-test suite.

## Repository layout

```
src/
  server.js              # entrypoint, env, lifecycle, PostgresStore selection
  db/                    # idempotent schema + bootstrap
  catalog/               # catalog business module + repository
  loans/                 # loans business module + repository
  store/                 # store interface, PostgreSQL + in-memory (test) adapters
  http/                  # Express app, routes, request validation
public/                  # browser UI (HTML/CSS/JS)
test/                    # unit tests (inject in-memory adapter)
```

## Testing

`npm test` runs meaningful unit tests **without** a live PostgreSQL, Redis, or
identity provider — the tests inject an in-memory adapter through dependency
injection. Real PostgreSQL behavior (transactions, row locks, idempotent
returns, concurrency) is exercised separately by the runtime HTTP acceptance.

## Design notes

See [`architecture-decisions.md`](architecture-decisions.md) for recorded
decisions and assumptions, [`plan.json`](plan.json) for the delivery plan, and
[`traceability.json`](traceability.json) for source-to-test traceability.