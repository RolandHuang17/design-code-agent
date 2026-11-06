# Minimal HTTP Health Service

A small stateless Node.js 22 HTTP service built exclusively with the Node.js
built-in `http` module and `node:test`. It exposes a health endpoint and answers
unknown routes with a JSON error. No database, Docker, identity provider,
third-party packages, or cloud infrastructure is required.

## Requirements

- Node.js `>=22.0.0`

## Install

There are no third-party dependencies, so installation is just confirming the
runtime:

```bash
node --version   # should be >= 22.0.0
npm install      # no-op (no external packages)
```

## Start

Start the service on `process.env.PORT` (defaults to `3000`):

```bash
npm start
```

Then verify it:

```bash
curl -i http://localhost:3000/health
# HTTP/1.1 200 OK
# {"status":"ok"}
```

To use a custom port:

```bash
PORT=8080 npm start
```

## Test

Run the real HTTP test suite on an ephemeral loopback port (no mocks):

```bash
npm test
```

## Build

Validate the syntax of all source and test JavaScript files:

```bash
npm run build
```

## Project structure

```
app.cjs               Exported request handler + createServer() factory
server.cjs            Startup entry; listens on PORT (default 3000)
test/health.test.cjs  node:test suite using real HTTP on an ephemeral port
package.json          Engines, scripts, and CommonJS (.cjs) conventions
```

## Source-to-requirement mapping

| Requirement | Description | Source |
|-------------|-------------|--------|
| FR1 | `GET /health` returns HTTP 200 and JSON `{"status":"ok"}` | `app.cjs` (`handler`) |
| FR2 | Unknown routes return HTTP 404 and a JSON error; `/health` still works afterward | `app.cjs` (`handler`), verified by `test/health.test.cjs` |
| FR3 | `npm start` listens on `process.env.PORT` (default 3000) via a factory kept separate from the executable startup file | `server.cjs` (startup) + `app.cjs` (`createServer`) |
| NFR1 | `npm test` runs real HTTP tests on an ephemeral loopback port (`0`), checks health, unknown route, and health again, then closes the server (no mocks) | `test/health.test.cjs` |
| NFR2 | `npm run build` checks all source JavaScript syntax; deliver `package.json`, source, tests, and this README using CommonJS `.cjs` conventions | `package.json` (`build` script) |