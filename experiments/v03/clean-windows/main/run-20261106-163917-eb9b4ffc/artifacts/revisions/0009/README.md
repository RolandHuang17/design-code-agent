# Minimal HTTP health service

A small stateless Node.js 22 HTTP service built using only the built-in `http`
and `node:test` modules. No database, Docker, identity provider, or third-party
packages.

## Requirements

- Node.js 22 or newer.

## Install

No dependencies to install. The package declares an empty dependency set and
relies only on Node built-ins.

```sh
npm install
```

## Start

```sh
npm start
```

`npm start` runs `node src/server.cjs`, which listens on `process.env.PORT`
(default `3000`) and keeps the process alive. Verify the service with:

```sh
curl http://localhost:3000/health
# => {"status":"ok"}
```

## Test

```sh
npm test
```

`npm test` runs `node --test test/app.test.cjs`, which performs real HTTP
requests against an ephemeral loopback port (no mocks), checking:

1. `GET /health` returns HTTP 200 with JSON `{"status":"ok"}`.
2. An unknown route returns HTTP 404 with a JSON error.
3. `GET /health` still returns 200 after the unknown request.

The server is closed after testing.

## Build

```sh
npm run build
```

`npm run build` runs `node --check` over all source files to verify JavaScript
syntax.

## Source-to-requirement mapping

| File | Purpose | Requirements |
| ---- | ------- | ------------ |
| `src/app.cjs` | Exported `createServer()` factory returning an un-started `http.Server`. Handles `GET /health` (200, `{"status":"ok"}`) and all other routes (404 JSON error), without calling `listen()`. | FR1, FR2 |
| `src/server.cjs` | Executable startup entry. Imports the factory, parses `process.env.PORT` (default 3000), and listens without closing. Kept separate so tests never start a fixed-port server. | FR3 |
| `test/app.test.cjs` | Real HTTP tests on an ephemeral loopback port: health, unknown route, health again, then closes the server. | NFR1 |
| `scripts/check-syntax.cjs` | Build helper that runs `node --check` across all source files. | NFR1 (build) |
| `package.json` | Pinned empty dependency set with `start`, `test`, and `build` scripts; CommonJS (`.cjs`) conformance. | FR3, NFR1 |

### Requirements

- **FR1**: `GET /health` returns HTTP 200 and JSON `{"status":"ok"}`.
- **FR2**: Unknown routes return HTTP 404 and a JSON error. After an unknown
  request the service must still answer `/health`.
- **FR3**: `npm start` listens on `process.env.PORT`, default 3000. The exported
  application/server factory is separate from the executable startup file so
  tests do not start an uncontrolled fixed-port server.
- **NFR1**: `npm test` runs real HTTP tests on an ephemeral loopback port,
  checking health, unknown route, and health again; close the server after
  testing. Do not replace actual HTTP behavior with mocks.