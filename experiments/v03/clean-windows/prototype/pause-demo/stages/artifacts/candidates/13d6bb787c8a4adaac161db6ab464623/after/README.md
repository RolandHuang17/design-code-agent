# Minimal HTTP health service

A small stateless Node.js 22 HTTP service built only with the built-in `http`
and `node:test` modules. No third-party packages, database, Docker, identity
provider, or cloud infrastructure are required.

## Requirements

- Node.js 22 or later (`>=22`)

## Install

There are no third-party dependencies, so there is nothing to install. For
consistency with typical workflows, you may run:

```bash
npm install
```

## Start

```bash
npm start
```

This runs `node src/index.cjs`, which listens on `process.env.PORT`, defaulting
to `3000`:

```bash
PORT=8080 npm start
```

Verify it is running:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

## Test

```bash
npm test
```

This runs `node --test`, which executes real HTTP tests against an ephemeral
loopback port (the server listens on port `0`), checks `/health`, an unknown
route, and `/health` again, then closes the server. No mocks are used.

## Build

```bash
npm run build
```

This runs `node --check` across all source files (`.cjs` sources and the test
file) to verify JavaScript syntax.

## Project structure

```
.
├── package.json
├── src/
│   ├── app.cjs          # Exported HTTP server factory (no port is bound)
│   └── index.cjs        # Startup entrypoint (listens on PORT)
└── test/
    └── health.test.cjs  # Real ephemeral-port HTTP tests (node:test)
```

All source files use the CommonJS convention with the `.cjs` extension, matching
the `"type": "commonjs"` field in `package.json`.

## Source-to-requirement mapping

| Requirement | Description | Source file(s) |
| ----------- | ----------- | -------------- |
| FR1 | `GET /health` returns HTTP 200 with JSON `{"status":"ok"}` | `src/app.cjs` |
| FR2 | Unknown routes return HTTP 404 with a JSON error; `/health` still works afterwards | `src/app.cjs` |
| FR3 | `npm start` listens on `process.env.PORT`, default `3000`; exported factory kept separate from startup | `src/index.cjs` (startup), `src/app.cjs` (factory) |
| NFR1 | `npm test` runs real HTTP tests on an ephemeral loopback port (health, unknown route, health again) and closes the server; no mocks | `test/health.test.cjs` |
| NFR2 | `npm run build` checks source syntax; deliver `package.json`, source, tests, and `README.md`; consistent CommonJS `.cjs` convention | `package.json`, `README.md`, all `.cjs` files |
