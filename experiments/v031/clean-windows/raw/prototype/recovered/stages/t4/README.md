# Minimal HTTP health service

A small, stateless Node.js 22 HTTP service built only on the built-in `http`
and `node:test` modules. No database, Docker, identity provider, third-party
packages, or cloud infrastructure is used.

## Requirements

- Node.js 22 or newer (`node`, `npm`)

## Install

```sh
npm install
```

No third-party dependencies are declared, so this simply verifies the
environment.

## Start

```sh
npm start
```

`npm start` runs `node src/index.cjs`, which listens on `process.env.PORT`
(default `3000`). Example with a custom port:

```sh
PORT=8080 npm start
```

Verify the health endpoint:

```sh
curl -i http://localhost:3000/health
```

Expected response:

```
HTTP/1.1 200 OK
Content-Type: application/json

{"status":"ok"}
```

## Test

```sh
npm test
```

`npm test` runs `node --test`, which executes real HTTP tests over an
ephemeral loopback port (127.0.0.1:0). Tests assert that `/health` returns
200 with `{"status":"ok"}`, unknown routes return 404 with a JSON error, and
`/health` still answers correctly after an unknown-route request. The server
is closed after testing, and no HTTP behavior is mocked.

## Build

```sh
npm run build
```

`npm run build` checks the syntax of all CommonJS (`.cjs`) source files using
`node --check`.

## Source to requirement mapping

| Requirement | Description | Source / check |
| --- | --- | --- |
| FR1 | `GET /health` returns HTTP 200 and JSON `{"status":"ok"}` | `src/app.cjs` (route handling), `test/health.test.cjs` |
| FR2 | Unknown routes return HTTP 404 and a JSON error; service still answers `/health` afterwards | `src/app.cjs` (fallback route), `test/health.test.cjs` |
| FR3 | `npm start` listens on `process.env.PORT` (default 3000); exported factory is separate from the executable startup file so tests do not bind a fixed port | `src/index.cjs` (startup), `src/app.cjs` (factory) |
| NFR1 | `npm test` runs real HTTP tests on an ephemeral loopback port (health, unknown route, health again) and closes the server; no mocks | `test/health.test.cjs`, `npm test` (`node --test`) |
| NFR2 | `npm run build` checks all source JavaScript syntax; CommonJS `.cjs` conventions maintained | `npm run build` (`node --check`), `.cjs` file naming |

## Project layout

```
src/app.cjs           Exported createServer HTTP server factory (no fixed port)
src/index.cjs         Executable startup entry (listens on PORT, default 3000)
test/health.test.cjs  node:test suite with real HTTP requests on ephemeral port
package.json          npm scripts (start, test, build)
README.md             This document
```