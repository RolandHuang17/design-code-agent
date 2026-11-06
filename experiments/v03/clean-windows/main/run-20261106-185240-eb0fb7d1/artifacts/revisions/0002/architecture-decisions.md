# Architecture Decisions

## Context

The input is an operator-authored architecture-prototype demonstration asking for a minimal,
stateless Node.js 22 HTTP health service. Both supplied documents are consistent and require
only built-in modules.

## Decision Record

### ADR-1: Built-in modules only

- **Decision:** Use only `node:http` and `node:test`; declare zero runtime and dev dependencies.
- **Rationale:** The architecture document (line 6) explicitly forbids third-party packages, a
  database, Docker, identity provider, and cloud infrastructure.
- **Consequences:** No lockfile-managed dependencies; the host-generated lockfile will be empty of
  third-party packages. Tests must drive real HTTP over a loopback socket rather than a framework.

### ADR-2: Separate exported factory from executable startup

- **Decision:** `app.cjs` exports a `createServer()` factory returning an `http.Server`. `server.cjs`
  imports that factory and calls `listen()` on `process.env.PORT` (default 3000).
- **Rationale:** FR3 and NFR1 require that tests bind an ephemeral loopback port without starting an
  uncontrolled fixed-port server.
- **Consequences:** The factory is side-effect free with respect to listening, so tests control the
  port and can close the server in teardown.

### ADR-3: CommonJS with `.cjs` extension

- **Decision:** All source and test files use the `.cjs` extension and `require`/`module.exports`.
- **Rationale:** NFR2 mandates "consistent CommonJS conventions with .cjs source files".
- **Consequences:** No `"type": "module"` in package.json; ESM/CJS ambiguity is avoided.

### ADR-4: Stateless routing in a single handler

- **Decision:** One request handler maps `GET /health` to 200 `{"status":"ok"}` and every other
  route/method to 404 with a JSON error body `{"error":"not found"}`.
- **Rationale:** FR1, FR2 require the minimal routing behavior with no shared mutable state, so an
  unknown request can never affect a later `/health` response.
- **Consequences:** No routing library; correctness is validated by real HTTP tests.

### ADR-5: Portable entrypoint detection

- **Decision:** `server.cjs` guards `listen()` with a main-module check that works on Windows and
  POSIX (`require.main === module`).
- **Rationale:** Ensures `npm start` keeps a live listener alive on `PORT` without accidentally
  starting the server when the module is required elsewhere.

### ADR-6: No deployment ecosystem

- **Decision:** No Dockerfile, Docker Compose, gateway, or OpenAPI spec is produced.
- **Rationale:** The generic-node acceptance profile and the original document both scope this as a
  small library/service rather than a containerised multi-service deployment. A small service stays
  small.