# Architecture Decisions

## Context

The input is a minimal, stateless Node.js 22 HTTP health service. The original
design explicitly rules out a database, Docker, identity provider, third-party
packages, and cloud infrastructure. Only the built-in `http` and `node:test`
modules are permitted. The architecture view (PlantUML) shows four collaborating
parts: a Client, a Startup entry point, an exported HTTP server factory, and
real ephemeral-port tests.

## Decisions

### AD-1: Separate server factory from startup entry (FR3)
The listening server is constructed by an exported factory (`src/app.cjs`) that
never calls `listen()`. A separate executable (`src/server.cjs`) imports the
factory, resolves `process.env.PORT` (default `3000`), and calls `listen()`.
This lets tests bind an ephemeral loopback port (port 0) without ever starting
an uncontrolled fixed-port server.

### AD-2: Build on Node built-ins only (top-level constraint)
`package.json` declares no runtime or development dependencies. Behavior is
implemented with `node:http` and tests use `node:test` and `node:assert`.
This satisfies FR/NFR constraints with zero third-party surface area.

### AD-3: Stateless request handling
The service keeps no in-memory or external state. Every request is handled
independently: `GET /health` returns `200` `{"status":"ok"}`, and any other
route returns `404` with a JSON error. No persistence layer, cache, or
connection pooling exists, so FR2 (health still answers after an unknown
request) holds by construction.

### AD-4: CommonJS with `.cjs` extensions (NFR2)
All source and test files use CommonJS and the `.cjs` extension to give
unambiguous module semantics regardless of any surrounding `package.json`
`"type"` field. `require`/`module.exports` are used consistently.

### AD-5: Real HTTP tests on an ephemeral port (NFR1)
Tests call the exported factory, listen on `127.0.0.1` with port `0`, issue
real HTTP requests with `http.request`, assert status and body for `/health`,
an unknown route, and `/health` again, and close the server in an
`after`/teardown hook. No HTTP stack is mocked or replaced.

### AD-6: Build = syntax check (NFR2)
`npm run build` verifies source JavaScript syntax. The mechanism (invoking
`node --check` over each source file via a small helper script) is a derived
decision because the original document states the outcome ("checks all source
JavaScript syntax") without prescribing the tooling.

## Assumptions derived at implementation time (not from the source)

- Unknown-route JSON error body is shaped as `{"error":"Not Found"}`.
- `/health` and error responses use `Content-Type: application/json`.
- No custom process signal handling in the startup entry is required by the
  document, so default termination behavior is retained.