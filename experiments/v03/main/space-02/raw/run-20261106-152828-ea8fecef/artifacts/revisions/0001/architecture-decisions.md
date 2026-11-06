# Architecture Decisions — Space Fractions

This document records the architectural decisions, deviations from the source
materials, explicit assumptions, and contradictions resolved during design.
Sources are cited by document and line range.

## 1. Contradictions and resolutions

| # | Contradiction | Source A | Source B | Resolution / assumption |
|---|---|---|---|---|
| C1 | Error budget math | Architecture_Documentation.md (§G, line 181: "SLO: 99.99% uptime" + "Error budget: 1%") | Standard SLO formula: error budget = 100% − availability | 99.99% availability implies 0.01% error budget for the same window, not 1%. This is recorded as issue INPUT-001. We treat the **0.01%** value as the mathematically correct interpretation; the "1%" figure is treated as an editorial error. No runtime behavior depends on this number. |
| C2 | Node.js version | Architecture_Documentation.md (§D, "Node.js 18-20") | space-fractions.md (supplement: "Node.js 22+") | Supplement is dated later and is the operator acceptance contract; we use **Node.js 22+**. Original's PostgreSQL version is likewise superseded to PG16 (compatible per supplement runtime contract). |
| C3 | Persistence detail (JSONB single table) | Architecture_Documentation.md (§D: `games(id, game_state JSONB)`) | space-fractions.md (supplement: questions, answers, user-subject mapping, score serialization) | The original schema is a minimal sketch. The supplement requires ownership, deduplication, and question CRUD. We treat the original `games` table as the seed shape and expand it with question/answer/users tables required by the supplement's acceptance contract. Original SQL is kept verbatim in `sql/game_ddl.sql`; expanded schema lives in migrations. |
| C4 | Microservices vs. module boundary | Architecture_Documentation.md (§C: separate components) | space-fractions.md (supplement: "preserve microservices/PostgreSQL", separate service entrypoints) | We implement **separate service entrypoints** (game, question, user, admin, gateway) as distinct Node modules sharing a common library, exposed as one gateway process for the acceptance harness while preserving logical component boundaries. This satisfies "separate entrypoints" without over-fragmenting. |

## 2. Original requirements honored

The following are taken as-is from the original design and implemented:

- Microservices architecture with GameComponent, QuestionComponent, UserComponent
  (Architecture_Documentation.md §C).
- `GET /play` external API returning a `gameId` (Architecture_Documentation.md
  §D External APIs). Preserved for backwards compatibility alongside the
  supplement's richer `/api/games` endpoints.
- `internal.proto` `GameService.Play` contract (Architecture_Documentation.md §D
  Internal contracts).
- `games` table with `id SERIAL PRIMARY KEY, game_state JSONB` seed schema.
- Data ownership: GameComponent owns game state; QuestionComponent owns question data.
- Backwards compatibility for 1 year / migration window 1 month.
- State machine: Playing ⇄ Paused → GameOver (Architecture_View.md State Diagram).
- Use cases: Play Game, View Score, Update Questions, View Help (Architecture_View.md Scenario View).

## 3. Supplement additions (operator-provided, not original)

These are requirements from space-fractions.md layered on top of the original
design. They are labeled as operator supplement because the original documents
do not specify them:

- Node.js 22+, exact rational arithmetic for fraction answers, server-side input validation.
- Full question/answer lifecycle, owner-based authorization, pause/resume.
- Keycloak 24.0.5 OIDC with PKCE S256, admin roles, account audience.
- Redis cache, RabbitMQ score events, Elasticsearch question search, Prometheus metrics.
- Gateway on container port 3000, Keycloak on 8080.
- Compose services: gateway, game-service, question-service, user-service,
  admin-service, postgres, redis, rabbitmq, elasticsearch, keycloak, prometheus.
- Demo users student/student, admin/admin, other/other (local-only demo).
- PG16 SQL constraints: no `EXCLUDED` in `RETURNING`; simple transactions.

## 4. Explicit assumptions (labeled, not in source)

| ID | Assumption |
|---|---|
| A-1 | OIDC subject (`sub`) is mapped to a numeric internal user id via an upsert on first-seen. The supplement requires "map verified sub strings to numeric internal user IDs"; the exact table name and upsert semantics are assumed. |
| A-2 | "Answer" normalizes to a single reduced fraction string; equality of correct/answer is decided by exact rational equality after reducing numerator/denominator (gcd). |
| A-3 | Question order is stable via a deterministic sort key (insertion order / id). |
| A-4 | A game's `questions` list may be empty at creation; questions are drawn from seeded question bank when `questionIds` is omitted. |
| A-5 | The admin role is identified by Keycloak realm role `admin` present in the token's `realm_access.roles`. |
| A-6 | RabbitMQ/Elasticsearch/Redis/Prometheus are integrated as real clients with bounded timeouts; their absence must not break the gateway (degrades to pass-through PostgreSQL / in-memory fallback with logs). |
| A-7 | Original `GET /play` returns a `gameId` (integer) and starts a default question set. |

## 5. Architecture style decision

- **Primary**: Microservices per original §C, realized as separate service
  modules behind one gateway process (see C4). This keeps the deployment a
  small, runnable Node application while honoring the "separate components"
  requirement and the "preserve microservices" supplement directive.
- **Persistence**: PostgreSQL as the system of record; Redis as a read-through
  cache; RabbitMQ for score-change events; Elasticsearch for question search.
- **Auth**: OAuth2/OIDC via Keycloak with JWKS validation (issuer/audience),
  admin role enforcement on admin endpoints.

## 6. Non-goals / reference-only artifacts

Per the supplement, the following are provided as **reference-only** and are
NOT claimed production-validated (see §"unverified infrastructure" in README):

- Kubernetes manifests (`k8s/`), Jenkinsfile, AWS Terraform example, Vault and
  Istio reference configuration.

These are labeled explicitly in their file headers and in the README.

## 7. Verification approach

- `npm test` runs node:test unit tests with in-memory adapters (no live DB/Redis/Keycloak).
- `npm run test:integration` runs integration tests against live infra (Compose).
- Real database behavior is exercised by the protected runtime HTTP acceptance harness.
- Build script performs a real syntax/consistency check (no placeholder echoes).