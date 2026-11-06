# Architecture Decisions & Deviations

Space Fractions — sixth-grade fraction learning application. This file records explicit
decisions, source conflicts, and assumptions. Original documents are treated as design
data; the operator supplement (`space-fractions.md`) is a separately-labelled acceptance
contract and is never attributed to the original teacher requirements.

## 1. Architectural style

- **Decision:** Microservices with a browser-facing gateway.
- **Sources:** `Architecture_Documentation.md` (A. Executive Summary: "microservices approach",
  C. Architecture Overview: GameComponent / QuestionComponent / UserComponent); component
  diagram in `Architecture_View.md` adds AdminComponent. The operator supplement mandates a
  gateway plus game/question/user/admin service entrypoints and Compose service IDs.
- **Result:** gateway + game-service + question-service + user-service + admin-service,
  coordinated by `compose.yaml`.

## 2. Runtime / framework versions (conflicts recorded)

| Concern | Original source | Supplement | Decision |
| --- | --- | --- | --- |
| Node.js | 18–20 (`Architecture_Documentation.md` D "Language/runtime") | 22+ (`space-fractions.md`) | Node.js 22+ |
| Express | 4–5 | Express (unversioned) | Express 4.x (pinned) |
| PostgreSQL | 14–15 | "supported PG16" | PostgreSQL 16 |

- **Rationale for Node 22+:** the operator runtime contract tests against Node 22+ and
  pinned dependencies; the original listed a range to justify ASR-1/NFR-1/ASR-2, not a hard
  floor. This is an explicit assumption (see section 5).

## 3. Data ownership & persistence model

- **PostgreSQL owns all game state** (`space-fractions.md` runtime contract). The original
  `games` table (`id SERIAL, game_state JSONB`) is generalized into a full relational schema
  so it can enforce owner authorization, per-game score serialization, and deduplication.
- **Sub → numeric user id:** verified OIDC `sub` strings are mapped to internal numeric
  `users.id` in PostgreSQL (user-service owns this mapping).
- **Schema** (superset of the original `games` DDL; the original table name is preserved):
  - `users(id, subject, username, created_at)` — unique `subject`.
  - `questions(id, prompt, options JSONB, correct_answer TEXT, created_by, created_at)`.
  - `games(id, owner_id, state, score, created_at)` — `state` is `playing|paused|over`.
  - `game_questions(game_id, question_id, position)` — stable order.
  - `answers(game_id, question_id, answer, correct, answered_at)` — unique per
    (game_id, question_id) for deduplication.
- **Rational arithmetic:** a shared `fraction.js` module implements exact rational (numerator/
  denominator) comparison and normalization. Server validates all fractions and compares
  `correct_answer` exactly, never by floating point.

## 4. API surface & compatibility

- **Original `GET /play` compatibility** is preserved (`space-fractions.md`): the OpenAPI
  document includes `GET /play` returning a `gameId`.
- **Acceptance contract** (operator supplement, authoritative for the gateway) is implemented
  verbatim: `/health`, `/api/admin/questions` CRUD, `/api/games` (create/get/pause/resume/
  answers/score), plus 400/401/403/404/409 semantics.
- `correctAnswer` must never appear in a player-facing response (game or answer endpoints).

## 5. Authentication / authorization

- **OAuth2/OIDC with Keycloak 24.0.5**, public browser client `space-fractions-client` using
  PKCE S256 (`space-fractions.md`).
- **Owner authorization:** every game is bound to its `owner_id` via the verified `sub`;
  other users' games yield 403 or 404. Admin endpoints require an admin realm role; normal
  users get 403.
- Backend validates `issuer`, `audience`, and JWKS (`http://keycloak:8080/.../certs` internal);
  public URLs derive from `OIDC_ISSUER` / `OIDC_PUBLIC_ORIGIN` / `PUBLIC_ORIGIN`.
- **Local-only demo accounts** (clearly labelled, not production guidance): `student/student`,
  `admin/admin`, `other/other`; direct access grants are enabled for the local-only resource
  owner password-grant fixtures. Browser flows still use authorization code + PKCE.

## 6. Score consistency (transactional correctness)

- Score updates are **serialized per game** and deduplicated within the same owned PostgreSQL
  transaction. A repeat answer to an already-answered question either returns idempotent 200 or
  409 and never increments score.
- `EXCLUDED ... RETURNING` is avoided (illegal on PG16); plain transaction statements are used.

## 7. Infrastructure integrations (labelled)

- **Required runtime integrations (real clients, not stubs):** PostgreSQL (state), Redis
  (cache), RabbitMQ (score events), Elasticsearch (question search), Prometheus (metrics).
- **Reference-only configurations (NOT production-validated):** Kubernetes manifests, Jenkinsfile,
  AWS Terraform, Vault reference, Istio reference. These are labelled `reference-only` and do not
  establish any validation results.

## 8. Observability / SLO conflict (INPUT-001)

- Original: "SLO: 99.99% uptime", "Error budget: 1%". These conflict: 99.99% availability
  implies a 0.01% error budget for the same window.
- **Decision:** record both source locations and adopt the mathematically consistent value:
  error budget = 0.01% for a 99.99% SLO. No performance/availability result is fabricated.

## 9. Testing strategy

- `npm test` runs unit/integration tests **without live PostgreSQL/Redis/OIDC/Elasticsearch**
  using dependency-injected in-memory adapters (scoring, pause/resume, authorization, invalid
  fraction input, dedup, error behavior).
- Real HTTP + SQL behavior is exercised separately by protected runtime acceptance
  (`run_check runtime`), not by `npm test`. No test is gated entirely on external infra.

## 10. Module conventions

- CommonJS for small Node modules (Express 4, `node:test`); no bundler. Browser UI is plain
  HTML/CSS/JS served by the gateway.
- Pinned dependency versions; `package-lock.json` is generated by the host (not committed by
  the model).

## Assumptions requiring explicit attribution (not in any source)

1. Node.js 22+ overrides the original 18–20 range (operator runtime target).
2. PostgreSQL 16 overrides the original 14–15 range.
3. The original `games` `JSONB game_state` column is expanded into normalized tables while
   retaining the `games` table name and `state`-per-game semantics.
4. `GET /play` maps to game creation on the gateway (returns the new `gameId`) for backwards
   compatibility; no original machinery for `/play` beyond the OpenAPI shape is specified.
5. Question order is stable by explicit `position` (supplement: "Stable question order").
6. Error budget resolved to 0.01% (INPUT-001).