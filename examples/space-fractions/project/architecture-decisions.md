# Architecture Decisions Record – Space Fractions

## AD-001: Microservices Granularity
**Decision:** Implement four services: `game-service`, `question-service`, `user-service`, `admin-service`.
**Source:** Architecture_Documentation.md §C, Architecture_View.md ComponentDiagram, user prompt.
**Rationale:** The Component, Package, and Container diagrams all identify Game, Question, User, Admin as distinct artifacts. The user prompt mandates "separate game, question, user, admin service entrypoints."
**Deviation from architecture doc:** The doc lists three components (Game, Question, User); we add Admin as a fourth per the views and prompt contract.

## AD-002: Gateway API on Port 3000
**Decision:** A single Express gateway on port 3000 serves both the REST API (per OpenAPI contract in prompt) and the browser UI.
**Source:** User prompt ("gateway on port 3000").
**Assumption:** The original architecture doc's `/play` endpoint is absorbed into `POST /api/games` + `GET /api/games/:id`. The legacy `/play` GET is also preserved for backward compatibility as documented in the architecture doc.

## AD-003: Technology Stack Versions
**Decision:** Node.js 22 (prompt), Express 4.21 (pinned), PostgreSQL 16 (pinned), Redis 7 (pinned), RabbitMQ 3.13 (pinned), Elasticsearch 8 (pinned).
**Source:** User prompt overrides Architecture_Documentation.md default stack (Node 18, PG 14, Redis 6, ES 7).
**Rationale:** Prompt says "Node.js 22+" and "dependency versions pinned (no latest)." Architecture doc range maxima are used where prompt is silent, ensuring current but pinned versions.
**Conflict resolved:** Prompt "Node.js 22+" vs doc "Node.js 18-20" → prompt takes precedence.

## AD-004: Exact Rational Arithmetic
**Decision:** Fraction answers are represented as `{numerator, denominator}` JSON objects. Server uses big-integer GCD reduction for exact equality checking. Strings like "1/2", "3/4" are accepted and parsed.
**Source:** User prompt ("Use exact rational arithmetic for fraction answers").
**Assumption:** All question answers are positive or negative fractions. Mixed numbers are not supported in answers (but may appear in prompts/options).

## AD-005: OAuth2/OIDC with Keycloak
**Decision:** Use Keycloak as the OIDC provider in Docker Compose. Validate tokens via JWKS endpoint, check `iss` and `aud` claims. Admin role is determined by a realm role `admin` present in the access token.
**Source:** User prompt ("use a real provider such as Keycloak in Compose, validate issuer/audience/JWKS and admin roles").
**Assumption:** The Keycloak realm is pre-configured with a `space-fractions` client and `admin` role. Import realm JSON provided in `keycloak/realm.json`. Default users: `student`/`studentpass`, `admin`/`adminpass`.

## AD-006: Scoring Semantics
**Decision:** Score = count of distinct correctly answered questions. Re-answering a correctly answered question is idempotent (200, same score). Answering a previously incorrect question correctly increases score. Score never decreases.
**Source:** User prompt ("Each correct answer counts 1. Repeating a question answer must not increase score").

## AD-007: Pause/Resume Semantics
**Decision:** Paused games reject answer submissions with 409. Pause only valid when in "playing" state. Resume only valid from "paused" state.
**Source:** User prompt, StateDiagram (Playing→Paused→Playing).

## AD-008: Game Authorization
**Decision:** Games are owned by the authenticated user who created them. Only the owner can access game state, submit answers, pause/resume, and view score. Non-owners get 404 (to avoid leaking game existence). Admins can access any game.
**Source:** User prompt ("Authorize each game by owner", "Other users' games -> 403 or 404").

## AD-009: Question CRUD Authorization
**Decision:** POST /api/admin/questions and DELETE /api/admin/questions/:id require the `admin` OIDC role. Non-admin authenticated users get 403. Unauthenticated requests get 401.
**Source:** User prompt.

## AD-010: Database Schema
**Decision:** Three main tables: `users` (id, sub, username, created_at), `questions` (id, prompt, options JSONB, correct_answer TEXT, created_by, created_at), `games` (id, user_id, state ENUM, score INT, question_ids INT[], current_question_index INT, created_at, updated_at). A `game_answers` table tracks per-question answers for score dedup.
**Source:** Architecture_Documentation.md §D (table sketch), ClassDiagram, user prompt requirements.
**Deviation:** Architecture doc has minimal `games(id, game_state JSONB)`. Expanded to normalized form for queryability.

## AD-011: Caching Strategy
**Decision:** Redis caches: (a) OIDC JWKS with 5-minute TTL, (b) game state with 30-minute TTL (write-through to PostgreSQL), (c) question list with 10-minute TTL.
**Source:** Architecture_Documentation.md §D "Caching & consistency strategy" and prompt "Integrate Redis (cache)."

## AD-012: Message Queue
**Decision:** RabbitMQ used for score events. When a correct answer is submitted, a `score.updated` event is published. A consumer logs/store score history. Not critical-path for answer response.
**Source:** User prompt and Architecture_Documentation.md.

## AD-013: Error Budget Conflict
**Decision:** The architecture doc claims "SLO: 99.99% uptime" and "Error budget: 1%." These are contradictory (99.99% → 0.01% error budget). We document the standard interpretation: 99.9% availability → 0.1% error budget as a more realistic target for this educational system.
**Source:** INPUT-001 conflict marker in prompt.
**Assumption:** 99.9% is the intended SLO; 99.99% was a typo. Noted in open questions.

## AD-014: Health Check
**Decision:** GET /health returns `{"status":"ok","timestamp":"..."}` with 200. Checks downstream PostgreSQL connectivity.
**Source:** User prompt.

## AD-015: Browser UI
**Decision:** Plain HTML/CSS/JS served at `/` from the gateway. No bundler. Fetches from the same-origin API. Implements: introduction screen, main menu, play view, help view, score view, ending/feedback view. Pause/resume buttons conditionally shown.
**Source:** User prompt ("plain browser HTML/CSS/JS (no bundler needed)").

## AD-016: Infrastructure Artifacts
**Decision:** Provide Docker Compose (full working stack), Dockerfiles per service, Kubernetes manifests, Jenkinsfile, Terraform AWS example, Vault reference config, Istio reference config. Reference-only configs labeled clearly.
**Source:** User prompt.
**Assumption:** Reference configs are syntactically valid but not validated in production environment.

## AD-017: Test Strategy
**Decision:** Unit tests using `node:test` (no Jest/Mocha). Integration tests separated and require `compose.yaml` running. Tests cover: scoring, pause/resume, authorization, invalid input, error behavior.
**Source:** User prompt.

## AD-018: Workspace Structure
**Decision:** npm workspaces with packages: `gateway`, `services/game-service`, `services/question-service`, `services/user-service`, `services/admin-service`, `shared`. Each service has its own Dockerfile.
**Source:** User prompt ("npm workspaces if needed").

## Open Questions
1. Expected user growth rate? (From Architecture_Documentation.md §K)
2. Expected game session length? (From Architecture_Documentation.md §K)
3. Is 99.99% or 99.9% the intended SLO? (INPUT-001 contradiction)
4. Should the legacy `/play` GET endpoint return HTML or JSON?
5. What fraction formats beyond "a/b" should be accepted? (decimals? mixed numbers?)

## Assumptions Summary
| ID | Assumption |
|----|-----------|
| A1 | ~1000 concurrent users (from Architecture_Documentation.md §K) |
| A2 | ~1 hour session length (from Architecture_Documentation.md §K) |
| A3 | Keycloak realm and users pre-provisioned; import file provided |
| A4 | Fraction answers are simple fractions "a/b" where a,b are integers, b≠0 |
| A5 | Admin role claim is `realm_access.roles` containing "admin" |
| A6 | Game "ending" triggers after all questions answered |
| A7 | Questions are multiple-choice with 4 options |
| A8 | Elasticsearch indices are created at startup (no external index management) |
| A9 | Prometheus metrics exposed on a separate metrics port (9090 per service) |