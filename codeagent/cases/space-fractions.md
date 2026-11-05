# Space Fractions supplementary implementation and acceptance contract

Origin: operator-provided benchmark supplement, NOT original teacher requirements.
Interpret the two original documents first. Record deviations and missing details.

Honor the input architecture: Space Fractions, sixth-grade fraction learning, microservices.
Use Node.js 22+, Express, plain browser HTML/CSS/JS (no bundler needed), PostgreSQL persistence.
Create separate game, question, user, admin service entrypoints. Implement introduction, main menu,
play, answers (do NOT send correct answers to players), scoring, score view, pause/resume,
ending feedback, help, and authenticated administrator question CRUD.
Use exact rational arithmetic for fraction answers. Validate input server-side. Authorize each game by owner.
OAuth2/OIDC: use a real provider such as Keycloak in Compose, validate issuer/audience/JWKS and admin roles.
Implement bounded downstream timeouts and error handling, migrations, idempotent seed data, health checks.

Independent acceptance contract (implement this gateway on port 3000, documented in OpenAPI):
GET /health returns 200; serve browser UI at /. Authenticated endpoints use Bearer OIDC access tokens.
POST /api/admin/questions accepts {prompt,options:[string],correctAnswer:string} -> 201 {id,...}.
DELETE /api/admin/questions/:id -> 200 or 204; normal users must get 403 on admin endpoints.
POST /api/games accepts optional {questionIds:[id]} for reproducible practice -> 201 {id,questions:[{id,prompt,options}]}.
GET /api/games/:id -> 200 with game state. Never include correctAnswer in a player response.
POST /api/games/:id/pause and /resume -> 200. Answering while paused -> 409.
POST /api/games/:id/answers accepts {questionId,answer} -> 200 {correct:boolean,score:integer}.
Each correct answer counts 1. Repeating a question answer must not increase score (409 or idempotent 200).
GET /api/games/:id/score -> 200 {score:integer}. Other users' games -> 403 or 404.
Malformed fractions -> 400. Missing/invalid credentials -> 401.

Aim to implement the full supplied architecture. Integrate Redis (cache), RabbitMQ (score events),
Elasticsearch (question search), Prometheus metrics. Provide working Compose configuration,
Dockerfiles, SQL, REST OpenAPI (including original GET /play compatibility), internal.proto,
Kubernetes resources, Jenkinsfile, AWS Terraform example, Vault and Istio reference configuration.
Reference-only configurations must be labeled and must not be claimed production-validated.
Do not fabricate performance, availability, deployment or security validation results.
When source materials contradict, document both source locations and your explicit assumption.

Required root files: README.md, package.json (scripts test, build, start), openapi.yaml,
internal.proto, compose.yaml, plan.json, traceability.json, architecture-decisions.md.
Use npm workspaces if needed. Use node:test for tests, dependency versions pinned (no latest).
Tests must assert scoring, pause/resume, authorization, invalid input, and error behavior.
Do not make all tests require running infrastructure; separate integration tests and explain how to run.
Build script must actually check/prepare source, never echo a successful message in place of checking.
README must explain local/Compose run, URLs, clearly labelled local-only demo accounts, tests,
architecture deviations, runtime requirements, and unverified infrastructure.


Runtime contract:
- Compose service IDs: gateway, game-service, question-service, user-service, admin-service, postgres, redis, rabbitmq, elasticsearch, keycloak, prometheus.
- Browser gateway container port3000; Keycloak container port8080. All public links and realm redirects derive from PUBLIC_ORIGIN and OIDC_ISSUER, not a fixed host port.
- Use Keycloak24.0.5. Its image includes bash but no curl/wget. Public browser client space-fractions-client requires PKCE S256. Demo users student/student, admin/admin, other/other; all profile names nonempty. Include account audience. RedirectUris/webOrigins may use '+' default redirect origins plus explicit localhost3000/3100; the host acceptance harness configures its temporary random-port origin through Keycloak administration.
- Backend OIDC_ISSUER must use the supplied public issuer; OIDC_JWKS_URI uses http://keycloak:8080/realms/space-fractions/protocol/openid-connect/certs. Keycloak public frontend KC_HOSTNAME_URL must use the public issuer's base origin (environment OIDC_PUBLIC_ORIGIN); HTTP remains8080 internally.
- PostgreSQL must own all game state; map verified sub strings to numeric internal user IDs. Use one owned transaction client, rollback on error, and idempotent migrations/seeds. Every seed answer must be a valid single fraction accepted by the same validator. Stable question order.
- Score updates must serialize per game and deduplicate in the same transaction. Do not use EXCLUDED in PostgreSQL RETURNING (illegal on supported PG16); prefer simple transaction statements over elaborate CTEs. Keep individual tests plus real HTTP acceptance. Mock DB success does not establish SQL validity.
- GET /api/admin/questions returns {questions:[{id,prompt,options,correctAnswer}]}. Search and metrics must have real clients, not placeholder responses.
- Preserve microservices/PostgreSQL; other infrastructure is required code integration, cloud configs are references. Keep modules concise: aim for at most35 source/config/test files, grouping related utilities where appropriate. No empty stubs to meet count.
