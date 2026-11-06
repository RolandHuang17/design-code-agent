# Architecture Decisions

## AD-1: Minimal library-like service, no external runtime dependencies
The design mandates only built-in `http` and `node:test`. We use no third-party packages, no database, no Docker, no identity provider, no cloud infrastructure. This keeps the repository small and runnable on Node.js 22 with zero `npm install` network fetches beyond the Node runtime.

## AD-2: Separate exported server factory from the executable startup entry
FR1/FR2 state the HTTP behavior; FR3 explicitly requires the application/server factory to be separate from the startup file so tests do not spawn an uncontrolled fixed-port server. We implement:

- `src/app.cjs` — exports `createServer()` (derived name, see assumptions) returning an `http.Server` with the request handler; it never calls `listen`.
- `src/server.cjs` — imports the factory, reads `process.env.PORT` (default 3000), and calls `listen`.

This directly mirrors the PlantUML view: Startup → Application ("create and listen on PORT") and Tests → Application ("create and listen on loopback random port").

## AD-3: Stateless request handler
The handler matches only `GET /health` (200 JSON `{"status":"ok"}`) and returns 404 JSON for every other route. No mutable state is kept, guaranteeing FR2's requirement that `/health` still answers correctly after an unknown request.

## AD-4: Real HTTP tests on an ephemeral port
NFR1 forbids mocks. Tests import the factory, listen on loopback `127.0.0.1:0`, use Node's built-in HTTP client (`http.get`) to assert health → unknown → health, and close the server in an `after()` hook. Port 0 lets the OS assign a free ephemeral port in every run.

## AD-5: Syntax-check build without third-party tooling
NFR2 requires `npm run build` to check all source JavaScript syntax. Since third-party linters are disallowed, `scripts/check-syntax.cjs` invokes `node --check` on each `.cjs` source file and fails on any non-zero exit.

## AD-6: CommonJS `.cjs` conventions
NFR2 requires consistent CommonJS with `.cjs` source files. All source and test files use `.cjs` and `module.exports`/`require`.