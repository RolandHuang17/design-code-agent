# Architecture Decisions

## Context

Two operator-authored inputs describe a minimal stateless Node.js 22 HTTP health
service: `a.md` (functional/non-functional requirements) and `v.md` (a PlantUML
component view). Both are consistent; `v.md` elaborates the structure already
implied by `a.md` FR3/NFR1.

## Decisions

### AD-1: Single-file application factory (`src/app.cjs`)

The exported server factory lives in its own module and returns a configured
`http.Server` without starting a listener. This satisfies FR3 ("keep the exported
application/server factory separate from the executable startup file") and the
UML split between "Exported HTTP server factory" and "Startup entry".

Rationale: a listener-free factory is testable on an ephemeral port and reusable
by both startup and tests without side effects.

### AD-2: Separate executable startup (`src/index.cjs`)

The startup entry reads `process.env.PORT` (default 3000), calls the factory, and
calls `listen`, which keeps the Node process alive. This directly maps to the UML
"Startup --> Application : create and listen on PORT" relation.

### AD-3: CommonJS `.cjs` modules

NFR2 requires consistent CommonJS conventions with `.cjs` source files. The
package declares `"type": "commonjs"` and all source/test files use `.cjs`, using
`require` / `module.exports` throughout.

### AD-4: Built-in modules only

Only `node:http` and `node:test` are used. No third-party packages, database,
identity provider, Docker, or cloud infrastructure (explicitly excluded by the
source). `package.json` has zero runtime dependencies.

### AD-5: Real ephemeral-port HTTP tests

NFR1 requires real HTTP behavior without mocks. The test creates the server on
loopback port `0` (OS-assigned ephemeral port), issues actual HTTP requests with
`http.request`, asserts health -> unknown -> health, and closes the server in a
fixture teardown. This matches "Tests --> Application : create and listen on
loopback random port".

### AD-6: `node --check` as the build step

The build script must "check all source JavaScript syntax" with no build tooling
available. `node --check` on each `.cjs` source file performs a parse-time syntax
check with zero dependencies.

## Assumptions (origin=assumption, not user-specified)

- The JSON body for the 404 response is unspecified by the source; a minimal
  `{"error":"not found"}` is chosen.
- `Content-Type: application/json` is emitted on all responses.