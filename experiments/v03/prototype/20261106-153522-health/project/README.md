# Minimal HTTP Health Service

A small, stateless Node.js 22 HTTP service built using only the built-in
`http` and `node:test` modules. It exposes a single health endpoint plus a
JSON 404 response for unknown routes. There is no database, Docker, identity
provider, third-party package, or cloud infrastructure involved.

## Requirements

- Node.js 22 or later (`>=22`)

## Install

There are no third-party dependencies. To prepare the project:

```sh
npm install
```

> `npm install` is optional here because no packages are declared, but it
> validates the `package.json` and creates a lockfile/layout if one is used.

## Start

Start the service with:

```sh
npm start
```

The server listens on `process.env.PORT`, defaulting to `3000`. To use a
different port:

```sh
PORT=8080 npm start
```

Verify it is running:

```sh
curl http://localhost:3000/health
# {"status":"ok"}
```

## Build (syntax check)

Check the syntax of all source JavaScript files:

```sh
npm run build
```

`npm run build` runs `node --check` against each `.cjs` source file
(`app.cjs`, `index.cjs`, and `test/health.test.cjs`) to verify syntax without
executing the server.

## Test

Run the real HTTP test suite:

```sh
npm test
```

`npm test` uses `node --test` to run `test/health.test.cjs`. The tests start
the service on an ephemeral loopback port (port `0` on `127.0.0.1`) and issue
real HTTP requests over the network. They check `/health`, an unknown route,
and `/health` again, then close the server. No HTTP behavior is mocked.

## Source-to-requirement mapping

| Requirement | Summary | Implementation |
| ----------- | ------- | -------------- |
| FR1 | `GET /health` returns HTTP 200 and JSON `{"status":"ok"}` | `app.cjs` `createApp()` handles `GET /health`, responding with `200` and `Content-Type: application/json` |
| FR2 | Unknown routes return HTTP 404 with a JSON error, and `/health` still works afterward | `app.cjs` responds `404` with JSON `{"error":"not_found"}` for any other route; the request handler is stateless, so /health remains available |
| FR3 | `npm start` listens on `process.env.PORT` (default `3000`); server factory is separate from the startup entry | `index.cjs` creates the app and listens on `PORT`; `app.cjs` exports only `createApp()` (not listening) |
| NFR1 | `npm test` runs real HTTP tests on an ephemeral loopback port (health, unknown, health again) and closes the server | `test/health.test.cjs` uses `node:test` + `http.get` against a server on `127.0.0.1:0`, closing it in `after` |
| NFR2 | `npm run build` checks source syntax; CommonJS `.cjs` conventions; README with instructions and mapping | `package.json` `build` script runs `node --check`; all source uses `require`/`module.exports` in `.cjs` files; this document |

## Project layout

```
.
├── app.cjs                 # Exported HTTP server factory (createApp)
├── index.cjs               # Startup entry (listen on PORT)
├── package.json            # Scripts and engine pin (Node >=22)
├── README.md               # This document
└── test/
    └── health.test.cjs     # Real HTTP tests on an ephemeral port
```