# Minimal HTTP health service

A small, stateless Node.js 22 HTTP service built only with the built-in `http` and
`node:test` modules. No database, Docker, identity provider, or third-party packages.

## Install

```sh
npm install
```

This project has no runtime or development dependencies; the install step only
prepares the workspace.

## Start

```sh
npm start
```

`npm start` runs `server.cjs`, which listens on `process.env.PORT` (default `3000`).

```sh
PORT=8080 npm start
```

Verify the service:

```sh
curl http://localhost:3000/health
# -> {"status":"ok"}
```

## Test

```sh
npm test
```

Runs real HTTP tests on an ephemeral loopback port using `node --test`. The tests
cover the health route, an unknown route, and the health route again afterward to
confirm the service remains stateless. The test server is closed in teardown; no
behavior is mocked.

## Build (syntax check)

```sh
npm run build
```

Checks the syntax of every source file with `node --check`.

## Source-to-requirement mapping

| Requirement | Description | Source | Test |
| --- | --- | --- | --- |
| FR1 | `GET /health` returns HTTP 200 and JSON `{"status":"ok"}` | `app.cjs` | `test/health.test.cjs` |
| FR2 | Unknown routes return HTTP 404 and a JSON error; subsequent `/health` still works | `app.cjs` | `test/health.test.cjs` |
| FR3 | `npm start` listens on `process.env.PORT` (default 3000); factory kept separate from startup | `app.cjs`, `server.cjs` | — |
| NFR1 | `npm test` runs real HTTP tests on an ephemeral loopback port and closes the server | — | `test/health.test.cjs` |
| NFR2 | `npm run build` syntax-checks all source; CommonJS `.cjs` convention throughout | `app.cjs`, `server.cjs` | — |

## Layout

- `app.cjs` — exported `createServer()` factory mapping routes (`GET /health` vs 404).
- `server.cjs` — executable startup entry that imports the factory and listens on `PORT`.
- `test/health.test.cjs` — real HTTP tests on an ephemeral loopback port.
- `architecture-decisions.md` — architecture decision record.
- `plan.json`, `traceability.json` — plan and requirement traceability.