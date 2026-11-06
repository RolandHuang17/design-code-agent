# Architecture Decisions

This document records the architecture decisions for the Space Fractions system, the
source of each decision, and any deviations or assumptions introduced while reconciling
the two input documents with the operator acceptance contract.

## Inputs

1. `Architecture_Documentation.md` (original design) — microservices architecture,
   technology stack, interfaces, data model, deployment, security, SRE, testing, migration.
2. `Architecture_View.md` (original design) — 11 PlantUML diagrams (use case, class,
   object, state, activity, sequence, collaboration, package, component, deployment, container).
3. `space-fractions.md` (operator benchmark supplement; NOT original design) — supplementary
   implementation and acceptance contract with a strict, independent runtime contract.

## Decision record

### AD-1: Architectural style — microservices with a browser gateway

- **Decision**: Separate service entrypoints for game, question, user, and admin, exposed
  through a single browser gateway on container port 3000.
- **Source**: Original design section C (`Architecture Overview`) lists GameComponent,
  QuestionComponent, UserComponent; supplement requires "separate game, question, user,
  admin service entrypoints" and a gateway on port 3000.
- **Deviation**: The original lists three components; the supplement adds an AdminComponent,
  consistent with the Admin actor in the use-case diagram. This is a supplement requirement,
  treated as authoritative for the runtime contract.

### AD-2: Runtime and framework versions

- **Decision**: Node.js 22+, Express (no bundler for the browser UI).
- **Source**: Supplement ("Use Node.js 22+, Express").
- **Conflict (INPUT-001-class)**: The original lists "Node.js 18-20" and "Express 4-5".
  We adopt the supplement (22+) as authoritative for the runnable deliverable and rely on
  pinned dependency versions. The original remains informational.

### AD-3: Scoring and answers — exact rational arithmetic

- **Decision**: Fraction answers are represented as normalized rationals (reduced
  numerator/denominator) and compared exactly. Correct answers are never returned to players.
- **Source**: Supplement ("Use exact rational arithmetic for fraction answers"; "do NOT send
  correct answers to players").
- **Contract**: A shared `fraction` module normalizes and validates input; every seed answer
  must pass the same validator.

### AD-4: Persistence and transactions

- **Decision**: PostgreSQL owns all game state. Verified OIDC `sub` strings map to numeric
  internal user IDs. All mutations use one owned transaction client with rollback on error.
  Score updates serialize per game and deduplicate in the same transaction (no `EXCLUDED` in
  `RETURNING`, no elaborate CTEs).
- **Source**: Supplement runtime contract. Original data model (`games` table with `game_state
  JSONB`) is extended with proper owner/score/answer tables needed for the acceptance contract.

### AD-5: Authentication & authorization

- **Decision**: OIDC via Keycloak 24.0.5. Backend validates issuer, audience, and JWKS. Admin
  endpoints require an admin realm role. Public browser client uses authorization-code flow with
  PKCE S256 (direct access grants enabled only for the local-only demo fixtures).
- **Source**: Original section F (OAuth2) + supplement runtime contract.
- **Environment**: `PUBLIC_ORIGIN` drives browser redirects; `OIDC_ISSUER` and
  `OIDC_PUBLIC_ORIGIN` drive identity-provider public URLs; `OIDC_JWKS_URI` points at the
  internal Keycloak certs endpoint.

### AD-6: Required infrastructure integrations

- **Decision**: Redis (game-state cache), RabbitMQ (score events), Elasticsearch (question
  search), and Prometheus (metrics) are real client integrations, not placeholder responses.
  PostgreSQL is the source of truth; Redis is a cache only.
- **Source**: Original stack + supplement ("Search and metrics must have real clients").

### AD-7: Reference-only configuration

- **Decision**: Kubernetes resources, Jenkinsfile, AWS Terraform example, Vault, and Istio
  configurations are provided as clearly labeled reference material and are NOT claimed
  production-validated.
- **Source**: Supplement ("Reference-only configurations must be labeled and must not be
  claimed production-validated").
- **Deviation from original**: The original lists `k8s/spacefractions-deployment.yaml` and
  Terraform as first-class deliverables; we produce them but mark them reference-only,
  adopting the supplement's honesty constraint.

### AD-8: Testing strategy

- **Decision**: `node:test` unit tests run without live PostgreSQL/Redis/identity provider
  (dependency injection with in-memory adapters). Integration tests and the real HTTP
  acceptance are separate and documented. Tests cover scoring, pause/resume, authorization,
  invalid input, and error behavior.
- **Source**: Supplement + original section H.

### AD-9: Compose topology

- **Decision**: Compose service IDs are exactly: gateway, game-service, question-service,
  user-service, admin-service, postgres, redis, rabbitmq, elasticsearch, keycloak, prometheus.
  Gateway container port 3000; Keycloak container port 8080. No host networking, no external
  volumes, no privileged services, no Docker socket mounts; bind mounts are relative and
  inside the project.
- **Source**: Supplement runtime contract + host constraints.

## Explicit assumptions (not stated in any source)

- **A-1 (data-ownership)**: Each service has an HTTP entrypoint; the gateway multiplexes
  authenticated `/api/*` routes to the appropriate service, while game state writes are owned
  exclusively by PostgreSQL via the game service. Derived from the component diagram and the
  supplement's "separate entrypoints" requirement.
- **A-2 (question ordering)**: Questions are returned in a stable order (by `id` ascending)
  unless `questionIds` is supplied for reproducible practice.
- **A-3 (admin role name)**: The Keycloak realm role granting admin access is named `admin`.
- **A-4 (numeric user IDs)**: Internal user IDs are assigned by an idempotent upsert keyed on
  the verified `sub` string at first authenticated access.

## Conflicting source locations

- **Error budget**: `Architecture_Documentation.md` line 181 states "99.99% uptime" with
  "Error budget: 1%". A 99.99% SLO implies a 0.01% error budget. We record the 99.99% SLO and
  note the arithmetic discrepancy; we do not produce a fabricated validation result.
- **Component count**: original sections C and D describe three components; supplement
  requires four service entrypoints. Resolved in AD-1.
- **Runtime versions**: original Node 18-20 vs supplement Node 22+. Resolved in AD-2.