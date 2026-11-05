# Space Fractions

A web-based, interactive fraction-learning tool for sixth-grade students, implemented as a
microservices system. Players watch an introduction, navigate a main menu, answer fraction
questions with exact rational arithmetic, pause/resume games, view scores, and receive ending
feedback. Administrators can create and delete questions through authenticated endpoints.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Repository Layout](#repository-layout)
3. [Runtime Requirements](#runtime-requirements)
4. [Local Development (without Docker)](#local-development-without-docker)
5. [Docker Compose (recommended)](#docker-compose-recommended)
6. [URLs & Ports](#urls--ports)
7. [Accounts & Authentication](#accounts--authentication)
8. [Environment Variables](#environment-variables)
9. [API Contract](#api-contract)
10. [Testing](#testing)
11. [Build & Start Scripts](#build--start-scripts)
12. [Infrastructure Artifacts](#infrastructure-artifacts)
13. [Architecture Deviations & Assumptions](#architecture-deviations--assumptions)
14. [Known Limitations & Unverified Infrastructure](#known-limitations--unverified-infrastructure)

---

## Architecture Overview

The system follows a microservices architecture with four backend services behind a single
API gateway:

| Component | Responsibility | Port (Compose) |
|-----------|----------------|----------------|
| `gateway` | API composition, browser UI serving, OpenAPI spec, metrics aggregation | 3000 |
| `game-service` | Game state, answers, scoring, pause/resume | 3001 |
| `question-service` | Question storage, search (Elasticsearch), question retrieval | 3002 |
| `user-service` | User profiles, OIDC token validation helper | 3003 |
| `admin-service` | Question CRUD (create/delete) with admin-role authorization | 3004 |

Backing infrastructure (via Docker Compose): **PostgreSQL 16**, **Redis 7**, **RabbitMQ 3.13**,
**Elasticsearch 8**, **Keycloak 24** (OIDC), **Prometheus 2**.

The original architecture document (*Architecture_Documentation.md*) lists three components
(Game, Question, User); per the prompt contract and the Component/Package/Container diagrams,
a fourth **Admin** component is implemented. See
[`architecture-decisions.md`](architecture-decisions.md) (AD-001).

---

## Repository Layout

```
.
├── gateway/                  # Express API gateway (port 3000) + browser UI
│   ├── public/               # Plain HTML/CSS/JS (no bundler)
│   │   ├── index.html
│   │   ├── css/style.css
│   │   └── js/{api,app,ui}.js
│   └── src/{index,routes,middleware}.js
├── services/
│   ├── game-service/         # Game logic, scoring, pause/resume
│   ├── question-service/     # Questions + Elasticsearch search
│   ├── user-service/         # User profile + OIDC
│   └── admin-service/        # Question CRUD (admin only)
├── shared/                   # Cross-cutting npm package
│   └── src/{fraction,auth,db,cache,mq,metrics,errors}.js
├── sql/                      # Idempotent migrations & seed (001, 002)
├── test/integration/         # Integration tests (require running stack)
├── k8s/                      # Kubernetes manifests (reference)
├── terraform/                # AWS Terraform example (reference)
├── istio/                    # Istio service-mesh config (reference)
├── vault/                    # Vault config (reference)
├── keycloak/realm.json       # Pre-provisioned OIDC realm
├── prometheus/prometheus.yml # Scrape config
├── openapi.yaml              # REST API contract
├── internal.proto            # Inter-service gRPC contract
├── compose.yaml              # Full-stack Docker Compose
├── Jenkinsfile               # CI/CD pipeline (reference)
├── plan.json                 # Implementation plan
├── traceability.json         # Requirement-to-artifact traceability
└── architecture-decisions.md # ADRs, assumptions, conflicts
```

---

## Runtime Requirements

- **Node.js >= 22** (the prompt mandates 22+; this overrides the architecture doc's Node 18–20 —
  see AD-003).
- **npm >= 9** (npm workspaces).
- **Docker >= 20** and **Docker Compose >= 2** for the full stack.
- Ports 3000–3004 (services), 5432 (Postgres), 6379 (Redis), 5672/15672 (RabbitMQ), 9200
  (Elasticsearch), 8080 (Keycloak), 9090 (Prometheus) free on the host.

---

## Local Development (without Docker)

The services require PostgreSQL/Redis/RabbitMQ/Elasticsearch. For unit tests, no infrastructure
is required. To run a service standalone against already-running infrastructure:

```bash
cp .env.example .env            # edit values as needed
npm install                     # installs all workspaces
npm test                        # run unit tests (no infra required)
```

Each service reads its configuration from environment variables (see
[`.env.example`](.env.example)). Individual entrypoints:

```
node gateway/src/index.js
node services/game-service/src/index.js
node services/question-service/src/index.js
node services/user-service/src/index.js
node services/admin-service/src/index.js
```

> Note: services do **not** auto-load `.env`; export variables in your shell or use a process
> manager. SQL migrations are applied at startup (idempotent — see `sql/001_initial.sql`).

---

## Docker Compose (recommended)

The full system, including all backing infrastructure and a pre-provisioned Keycloak realm,
starts with:

```bash
cp .env.example .env   # optional; sane dev defaults exist
docker compose up --build
```

Health checks gate startup order. Wait for `gateway` to report healthy before testing:

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"..."}
```

To tear down (and remove the named volumes including DB data):

```bash
docker compose down -v
```

---

## URLs & Ports

| Service | URL |
|---------|-----|
| Browser UI / API gateway | http://localhost:3000 |
| Gateway metrics | http://localhost:3000/metrics (or 9090) |
| OpenAPI spec | http://localhost:3000/openapi.yaml |
| Keycloak admin console | http://localhost:8080 |
| RabbitMQ management UI | http://localhost:15672 |
| Elasticsearch | http://localhost:9200 |
| Prometheus | http://localhost:9090 |

---

## Accounts & Authentication

Keycloak is imported from `keycloak/realm.json` on first start (`--import-realm`). The realm
(`space-fractions`) pre-provisions two users **for local development only**:

| Username | Password | Role | Capabilities |
|----------|----------|------|--------------|
| `student` | `student` | `student` | Play games, view own scores |
| `admin` | `admin` | `admin` | All of the above + question CRUD |

> **Do not use these credentials in production.** They are development-only fixtures (AD-005).
> The Keycloak admin console login uses the `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`
> environment variables (default `admin`/`admin`).

The client uses the OAuth2/OIDC **Authorization Code + PKCE** flow where applicable, and validates
access tokens against the issuer's JWKS (`iss`, `aud`, signature). The `admin` realm role is
asserted via the `roles` claim (see `shared/src/auth.js`; AD-005).

Authenticated endpoints require a `Bearer` access token. Unauthenticated requests return `401`;
non-admin users hitting admin endpoints get `403`.

---

## Environment Variables

Full list with placeholders in [`.env.example`](.env.example). Key variables:

| Variable | Purpose |
|----------|---------|
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | PostgreSQL connection |
| `REDIS_URL` | Redis cache |
| `RABBITMQ_URL` | RabbitMQ for score events |
| `ELASTICSEARCH_URL` | Question search |
| `OIDC_ISSUER` | Keycloak realm issuer URL |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | OIDC client |
| `OIDC_AUDIENCE` | Expected `aud` claim (default `account`) |
| `PORT` | Gateway port (default 3000) |

No real secrets are committed anywhere; the repository contains placeholders and
development-only fixtures only.

---

## API Contract

The full REST contract is in [`openapi.yaml`](openapi.yaml), served by the gateway at
`/openapi.yaml`. Summary of the independent acceptance contract (gateway on port 3000):

- `GET /health` → `200`.
- Browser UI served at `/`.
- `POST /api/admin/questions` → `201 {id,...}` (admin only).
- `DELETE /api/admin/questions/:id` → `200`/`204` (admin only).
- `POST /api/games` `{questionIds?:[id]}` → `201 {id,questions:[{id,prompt,options}]}`.
- `GET /api/games/:id` → `200` game state. **Never** returns `correctAnswer` to players.
- `POST /api/games/:id/pause`, `POST /api/games/:id/resume` → `200`. Answering while paused → `409`.
- `POST /api/games/:id/answers` `{questionId,answer}` → `200 {correct,score}`; +1 per first
  correct answer; repeats are idempotent (`200`, no score change) or `409`.
- `GET /api/games/:id/score` → `200 {score}`. Other users' games → `403`/`404`.
- Malformed fractions → `400`; missing/invalid credentials → `401`.

The legacy `GET /play` endpoint from the architecture doc is preserved for backward
compatibility (see AD-002).

---

## Testing

| Command | Scope | Requires infra? |
|---------|-------|-----------------|
| `npm test` | Unit tests (fraction arithmetic, auth, game engine, scoring) | No |
| `npm run test:integration` | API contract, authz, pause/resume, scoring idempotency, errors | Yes (running stack) |
| `npm run test:all` | Both of the above | Yes |

Unit tests use Node's built-in `node:test` runner and assert:

- Exact rational fraction arithmetic (`1/2 == 2/4`).
- Scoring (each correct answer +1; repeats do not increase score).
- Pause/resume state transitions and `409` on answer-while-paused.
- Authorization (admin vs. non-admin; game ownership).
- Invalid input (`400`) and downstream error behavior.

Integration tests (`test/integration/*.test.js`) require the full stack:

```bash
docker compose up -d --build
npm run test:integration
```

---

## Build & Start Scripts

- `npm run build` — verifies/prepares source. Since services are plain Node.js, there is no
  compilation; the script performs static integrity checks rather than printing a hollow
  success message.
- `npm start` — informational; the intended runtime entry is `docker compose up` (all services)
  or individual `node <service>/src/index.js`.
- `npm run lint` — syntactic check of the gateway entrypoint via `node --check`.

---

## Infrastructure Artifacts

The following are provided to satisfy the architecture/prompt and are **labeled reference-only,
not production-validated**:

- `k8s/` — Deployments, Services, Ingress, ConfigMap, Namespace (syntactically valid manifests).
- `terraform/` — AWS example (ECS-style topology) for provisioning.
- `istio/` — Gateway, VirtualService, DestinationRules, PeerAuthentication.
- `vault/` — Policy and server config (HCL).
- `Jenkinsfile` — CI/CD pipeline stages (install → test → build → image publish).
- `prometheus/prometheus.yml` — scrape config for the per-service `/metrics` endpoints.

These reference configs are **not** claimed to have been validated in a production Kubernetes,
Terraform, Istio, or Vault environment. The working, validated runtime is Docker Compose.

---

## Architecture Deviations & Assumptions

Deviations from *Architecture_Documentation.md*, with rationale, are recorded in
[`architecture-decisions.md`](architecture-decisions.md). Highlights:

1. **Node.js 22+** (prompt) overrides the doc's Node 18–20 (AD-003).
2. **Four components** (Game, Question, User, **Admin**) vs. the doc's three (AD-001).
3. **Expanded schema** (users, questions, games, game_answers) vs. the doc's single
   `games(id, game_state JSONB)` (AD-010).
4. **SLO correction**: the doc lists 99.99% uptime with a 1% error budget, which are
   contradictory. Assumed intended SLO is **99.9%** (0.1% error budget) — AD-013, INPUT-001.
5. **Legacy `/play`** GET retained alongside `POST /api/games` (AD-002).

Recorded assumptions include: ~1000 concurrent users (A1), ~1-hour sessions (A2), simple
`a/b` fractions with integer numerator/denominator (A4), the `admin` role carried in the
`roles` claim (A5), and multiple-choice questions with 4 options (A7). The complete table is
in `architecture-decisions.md`.

---

## Known Limitations & Unverified Infrastructure

- **No bundler/build step**: the UI and services ship plain source; `npm run build` performs
  integrity checks only (by design, per prompt "no bundler needed").
- **Reference-only configs**: Kubernetes, Terraform, Istio, Vault, and Jenkins artifacts are
  syntactically plausible but **not validated in a real cluster/cloud**. Compose is the tested
  deployment target.
- **No performance/security validation**: no load, chaos, penetration, or vulnerability-scan
  results are claimed. The architecture doc's SLO/availability figures are documented as
  targets, not measured outcomes.
- **Development credentials**: the Keycloak realm, Postgres, and RabbitMQ fixtures use default
  credentials; replace before any non-local use.

---

## Traceability

Requirement-to-artifact mapping (covering the architecture doc's FR/NFR/ASR and all 13 supplied
diagrams) is in [`traceability.json`](traceability.json), and the implementation plan
(including assumptions and conflicts) is in [`plan.json`](plan.json).