# Space Fractions

Space Fractions is a sixth-grade fraction-learning game implemented as a set of
Node.js 22+ microservices. A browser gateway (port 3000) fronts four services —
game, question, user, and admin — backed by PostgreSQL (source of truth), Redis
(cache), RabbitMQ (score events), Elasticsearch (question search), Keycloak
(OIDC authentication/roles), and Prometheus (metrics).

The implementation honors the two original architecture documents
(`Architecture_Documentation.md`, `Architecture_View.md`) and the operator
benchmark supplement (`space-fractions.md`). Where those sources contradicted
each other, the resolution is recorded in `traceability.json`,
`plan.json`, and `architecture-decisions.md`.

## Features

- **Exact rational arithmetic** for fraction answers — no floating point.
  Fractions are stored, normalized, and compared as numerator/denominator pairs
  (`src/shared/fraction.js`).
- **Server-side input validation** — malformed fractions are rejected with 400.
- **Per-game owner authorization** — accessing another user's game returns
  403/404; admin endpoints require an administrator role.
- **Pause / resume** — answering while a game is paused returns 409.
- **Transactional, per-game serialized score updates** — each correct answer
  counts exactly 1; repeating a question never inflates the score.
- **Never leaks the correct answer** to players — server responses to players
  only include `id`, `prompt`, and `options`.
- **OIDC via Keycloak** — issuer/audience/JWKS validation plus ream-role
  checks; browser users use the authorization-code + PKCE S256 flow.

## Repository layout

```
src/shared/                       Shared domain + OIDC utilities
  fraction.js                     Exact rational fraction arithmetic + validator
  oidc.js                         JWT/JWKS verification, role extraction
src/metrics.js                    Prometheus metric registry helpers

packages/gateway/                 Browser gateway (port 3000), static UI, proxy
packages/game-service/            Game lifecycle, scoring, score events
packages/question-service/        Question CRUD + Elasticsearch index/search
packages/user-service/            OIDC auth + subject -> user-id mapping
packages/admin-service/           Authenticated administrator question CRUD

sql/migrations/001_schema.sql     Idempotent schema (games, users, questions, ...)
sql/seed.sql                      Idempotent seed data (valid single-fraction answers)

openapi.yaml                      REST API contract (incl. legacy GET /play)
internal.proto                    Internal gRPC contract (GameService.Play)

compose.yaml                      Full local topology (all 11 service IDs)
packages/*/Dockerfile             Per-service container images
infra/keycloak/realm.json         Realm import (demo users, PKCE S256 client)

k8s/, Jenkinsfile, terraform/,    REFERENCE-ONLY, unverified configuration
infra/vault-policy.hcl,
infra/istio-gateway.yaml
```

## Requirements

- Node.js 22+ (declared in `package.json` `engines`).
- For the full local topology: Docker with the Compose plugin. The Compose file
  pulls `postgres:16-alpine`, `redis:7-alpine`,
  `rabbitmq:3.13-management-alpine`,
  `docker.elastic.co/elasticsearch/elasticsearch:8.14.3`,
  `quay.io/keycloak/keycloak:24.0.5`, and `prom/prometheus:v2.53.1`.
- No container runtime is required to run the unit tests (see below).

## Running with Compose (full topology)

```bash
cp .env.example .env
docker compose up --build
```

Service IDs and container ports (internal):

| Service           | Container port |
|-------------------|----------------|
| `gateway`         | 3000           |
| `game-service`    | 3001           |
| `question-service`| 3002           |
| `user-service`    | 3003           |
| `admin-service`   | 3004           |
| `postgres`        | 5432           |
| `redis`           | 6379           |
| `rabbitmq`        | 5672 (mgmt 15672) |
| `elasticsearch`   | 9200           |
| `keycloak`        | 8080           |
| `prometheus`      | 9090           |

### URLs

- Browser UI / gateway: `http://localhost:3000/`
- Gateway health: `GET http://localhost:3000/health` → 200
- Keycloak (realm `space-fractions`): `http://localhost:8080/`
- Prometheus: `http://localhost:9090/`
- RabbitMQ management: `http://localhost:15672/`

> **Port remapping note:** the acceptance harness remaps host ports, so all
> public browser URLs and realm redirect/issuer links are derived at runtime
> from `PUBLIC_ORIGIN` and `OIDC_ISSUER`/`OIDC_PUBLIC_ORIGIN` — never from a
> hard-coded host port. The browser gateway container always listens on port
> 3000 and Keycloak on 8080 internally.

### Local-only demo accounts

The following accounts are **local development fixtures only** and are not
production guidance. They exist in `infra/keycloak/realm.json`:

| Username | Password | Role      |
|----------|----------|-----------|
| `student`| `student`| (none)    |
| `admin`  | `admin`  | `admin`   |
| `other`  | `other`  | (none)    |

The Keycloak deployment bootstrap admin (`KEYCLOAK_ADMIN=admin`,
`KEYCLOAK_ADMIN_PASSWORD=admin`) is a separate, local-only fixture used by the
harness to configure the realm; it is distinct from the realm `admin` user.

The `space-fractions-client` realm client enables `directAccessGrantsEnabled`
**only** so the local HTTP fixtures can obtain tokens via the password grant.
Browser users must still use the real authorization-code flow with PKCE S256.

## Running services without Docker

Individual services read their dependencies from environment variables (see
`.env.example`). For example:

```bash
npm install
npm run start:game-service   # requires DATABASE_URL, RABBITMQ_URL, OIDC_*
```

`npm start` runs only the gateway; the gateway expects downstream services at
`GAME_SERVICE_URL`, `QUESTION_SERVICE_URL`, `USER_SERVICE_URL`, and
`ADMIN_SERVICE_URL`.

## Tests

Unit/integration tests use Node's built-in test runner and in-memory adapters —
**no live PostgreSQL, Redis, RabbitMQ, Elasticsearch, or Keycloak is required**:

```bash
npm test            # runs all tests in test/
npm run test:unit   # explicit unit/integration suite
```

The tests cover:

- exact fraction parsing, normalization, and arithmetic (`test/fraction.test.js`)
- scoring correctness (each correct answer = 1, no repeat increment)
  (`test/scoring.test.js`)
- OIDC/authorization behavior (401/403/404) (`test/auth.test.js`)
- game routes: pause/resume (409 while paused), dedup, owner authorization,
  malformed fraction → 400 (`test/game-routes.test.js`)

Real database/HTTP behavior (PostgreSQL transaction semantics, idempotent
migrations/seeds, live Keycloak/JWKS) is exercised separately by the protected
runtime HTTP acceptance harness and is not part of `npm test`.

## Build

```bash
npm run build
```

The build script performs a real syntax/consistency check of the service source
and contract files; it does not emit a success message in place of checking.

## API contract

- REST: `openapi.yaml` (includes the original `GET /play` backwards-compatible
  endpoint returning `gameId`).
- Internal: `internal.proto` documents the internal `GameService.Play` contract.

Key REST endpoints (documented in `openapi.yaml`):

- `GET /health` → 200
- `POST /api/admin/questions` `{prompt, options:[string], correctAnswer:string}`
  → 201 `{id,...}` (admin only; non-admin → 403)
- `GET /api/admin/questions` → `{questions:[{id,prompt,options,correctAnswer}]}`
- `DELETE /api/admin/questions/:id` → 200/204 (admin only)
- `POST /api/games` (optional `{questionIds:[id]}`) → 201
  `{id, questions:[{id,prompt,options}]}`
- `GET /api/games/:id` → 200
- `POST /api/games/:id/pause` / `POST /api/games/:id/resume` → 200
- `POST /api/games/:id/answers` `{questionId, answer}` → 200 `{correct, score}`
- `GET /api/games/:id/score` → 200 `{score}`

Error behavior: malformed fraction → 400; missing/invalid credentials → 401;
non-owner access → 403/404; answering while paused or repeating an answer →
409 (or idempotent 200 for repeats).

## Architecture deviations and assumptions

The supplement and original documents conflict in a few places; each is
documented in `traceability.json` and `architecture-decisions.md`. Highlights:

- **Node.js version:** original 18–20 vs. supplement 22+; resolved to 22+.
- **PostgreSQL version:** original 14–15 vs. supplement PG16; resolved to 16.
- **Schema:** the original `games` table only stored a JSONB `game_state`. The
  supplement requires owner authorization and transactional score dedup, so the
  schema was expanded to normalized tables (`games`, `users`, `questions`,
  `game_questions`, `answers`) while preserving the original `games` naming.
- **Error budget (INPUT-001):** `Architecture_Documentation.md` line 181 states
  99.99% uptime and a 1% error budget; 99.99% availability implies a 0.01%
  error budget. Resolved to 0.01%.
- **`GET /play`:** mapped to gateway game creation returning `gameId`
  (backwards compatibility), per the original OpenAPI + internal proto.
- **ASR-1 traceability:** the original matrix maps the data-durability
  requirement to `QuestionComponent`/`sql/question_ddl.sql` while the shown
  schema is `games`; both are provided (`sql/game_ddl.sql` plus the full
  schema).

## Unverified (reference-only) infrastructure

The following files are provided as **reference-only** and have **not** been
production-validated. No performance, availability, deployment, or security
validation is claimed for them:

- `k8s/spacefractions-deployment.yaml`
- `Jenkinsfile`
- `terraform/main.tf`
- `infra/vault-policy.hcl`
- `infra/istio-gateway.yaml`

These reflect the original architecture document's Kubernetes/Jenkins/Terraform
direction and the supplement's reference-configuration requirement, but are not
exercised by any test or acceptance check.