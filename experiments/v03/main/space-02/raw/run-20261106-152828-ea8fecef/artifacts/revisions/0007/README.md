# Space Fractions

A web-based fraction-learning game for sixth graders, built as a document-driven
Node.js microservices implementation. The system lets students play a multiple-choice
fraction game, view their scores, pause/resume a game, and lets authenticated
administrators manage the question bank. All fraction answers use exact rational
arithmetic.

This repository implements the original *Architecture_Documentation.md* and
*Architecture_View.md* inputs, extended by an operator-provided acceptance contract
(`space-fractions.md`). The acceptance contract is authoritative for the runnable
shape of this project (Node.js 22+, Express, PostgreSQL, Keycloak OIDC, gateway on
port 3000) while preserving the original microservice architecture and data-ownership
boundaries.

## Architecture at a glance

| Component | Responsibility | Data it owns |
|-----------|----------------|--------------|
| `game-service` | Game lifecycle, pause/resume, answer scoring, score view | Game state, answer records, scores |
| `question-service` | Question CRUD, stable ordering, search | Questions, options, correct answers |
| `user-service` | Subject → numeric user-id mapping, profile | Internal user rows |
| `admin-service` | Admin-only question management surface | (delegates to question storage) |
| `gateway` | HTTP routing, OIDC auth, static UI, `/health` | — |

PostgreSQL is the system of record for all game state. Redis (read-through cache),
RabbitMQ (score events), Elasticsearch (question search), and Prometheus (metrics) are
integrated as real clients but degrade gracefully when absent so unit tests and local
development do not require live infrastructure.

## Requirements

- **Node.js 22+** (the acceptance contract supersedes the original Node.js 18–20 range)
- **PostgreSQL** for persistence (PG16-compatible; no `EXCLUDED ... RETURNING`)
- Optional, for the full Compose stack: Docker + Compose, Keycloak 24.0.5, Redis,
  RabbitMQ, Elasticsearch, Prometheus

No bundler is used; the browser UI is plain HTML/CSS/JavaScript.

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Key variables:

| Variable | Meaning |
|----------|---------|
| `PUBLIC_ORIGIN` | Public browser origin (e.g. `http://localhost:3000`), drives redirect URIs |
| `OIDC_ISSUER` | Public OIDC issuer URL (`http://localhost:8080/realms/space-fractions`) |
| `OIDC_PUBLIC_ORIGIN` | Keycloak public frontend base origin |
| `OIDC_JWKS_URI` | JWKS endpoint; internally `http://keycloak:8080/realms/space-fractions/protocol/openid-connect/certs` |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL`, `RABBITMQ_URL`, `ELASTICSEARCH_URL` | Optional integrations |

All public links and realm redirects derive from `PUBLIC_ORIGIN` and `OIDC_ISSUER`,
never from a fixed host port, because test runtimes remap ports.

## Running locally

```bash
npm install
npm run build      # actually checks sources + OpenAPI/proto presence
npm test           # unit tests, no live infra required
npm start          # start the gateway
```

### Running via Docker Compose

```bash
docker compose up --build
```

This starts the full stack: `gateway`, `game-service`, `question-service`,
`user-service`, `admin-service`, `postgres`, `redis`, `rabbitmq`, `elasticsearch`,
`keycloak`, `prometheus`. The browser gateway listens on container port **3000** and
Keycloak on container port **8080**. Point your browser at `http://localhost:3000`.

### URLs

- Browser UI: `http://localhost:3000/`
- Gateway health: `http://localhost:3000/health`
- Keycloak realm: `space-fractions` on `http://localhost:8080`

## Demo accounts (local-only)

These fixtures exist only for the local Compose demo and are **not** production
guidance. The application realm users are distinct from Keycloak's bootstrap admin
(`admin`/`admin`, set by the local harness only).

| Username | Password | Role |
|----------|----------|------|
| `student` | `student` | end user |
| `other`   | `other`   | end user |
| `admin`   | `admin`   | realm role `admin` |

Browser users authenticate with the real authorization-code flow using **PKCE S256**
on the public client `space-fractions-client`. The local HTTP acceptance fixtures may
use the password grant (enabled via `directAccessGrantsEnabled` **for local demo only**);
this is not a production recommendation.

## API summary

See `openapi.yaml` for the complete contract. Highlights:

- `GET /health` → 200
- `GET /` → browser UI
- `GET /play` → legacy compatibility (returns a `gameId`)
- `POST /api/games` `{questionIds?}` → 201 with questions (no `correctAnswer`)
- `GET /api/games/:id` → game state (no `correctAnswer`)
- `POST /api/games/:id/pause`, `POST /api/games/:id/resume`
- `POST /api/games/:id/answers` `{questionId, answer}` → `{correct, score}`
- `GET /api/games/:id/score` → `{score}`
- `POST /api/admin/questions` `{prompt, options, correctAnswer}` → 201
- `GET /api/admin/questions` → `{questions:[...with correctAnswer]}`
- `DELETE /api/admin/questions/:id` → 200/204

Behavioral rules enforced server-side:

- Each correct answer counts **1** point; repeating an answered question never
  increases the score (409 or idempotent 200).
- Answering while paused → 409.
- Malformed fraction → 400; missing/invalid credentials → 401.
- Normal users get 403 on admin endpoints; other users' games are 403/404.
- `correctAnswer` is never returned to players.

## Testing

```bash
npm test                 # unit tests (node:test, in-memory/fake adapters, no infra)
npm run test:integration # against live Compose stack (Keycloak, PG, etc.)
```

Unit tests cover scoring, pause/resume, authorization, invalid input (malformed
fraction), deduplication, and error behavior without requiring live services. The
default `npm test` does **not** require PostgreSQL, Redis, or an identity provider.
Integration tests are separate and must be run against running infrastructure.

## Architecture deviations & conflicts

Documented in `architecture-decisions.md`. Key points:

- **Node.js 20 (original) → Node.js 22+ (acceptance contract).** Contract wins.
- **Error budget:** the original states 99.99% availability alongside a 1% error
  budget; 99.99% availability implies a 0.01% error budget for the same window. Adopted
  0.01% (see `issues.INPUT-001`).
- **Original single-JSONB `games` table** is preserved (`sql/game_ddl.sql`) while the
  acceptance contract's expanded schema (questions/answers/users tables) is added via
  migrations.
- **Original `Node.js 18–20`/PostgreSQL guidance** superseded by the contract's
  Node.js 22+ and PG16 constraints.

## Unverified infrastructure

`k8s/`, `Jenkinsfile`, `terraform/`, and `reference/` (Vault, Istio) are
**reference-only** configurations labeled as such. They are not production-validated
and no performance, availability, deployment, or security validation results are
claimed.

## Repository layout

```
gateway/            Express app, HTTP entrypoints
services/           game/question/user/admin service modules
lib/                fraction arithmetic, game state, auth, db, cache, events, search
sql/                game_ddl.sql, migrations, idempotent seeds
public/             plain browser UI (no bundler)
test/               unit tests (default npm test)
k8s/ terraform/ reference/   reference-only infra configs
openapi.yaml        REST contract
internal.proto      GameService.Play proto contract
compose.yaml        full stack definition
```