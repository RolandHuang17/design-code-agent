# Minimal HTTP health service

A small, stateless Node.js 22 HTTP service built only with the built-in `http` and `node:test` modules. No database, Docker, identity provider, third-party packages, or cloud infrastructure is required.

## Requirements

- Node.js 22+

## Install

There are no third-party dependencies, so no install step is required. The project uses consistent CommonJS conventions with `.cjs` source files.

```sh
npm install   # optional; resolves to nothing beyond the runtime
```

## Start

```sh
npm start
```

`npm start` listens on `process.env.PORT`, defaulting to `3000`:

```sh
PORT=8080 npm start
```

## Test

```sh
npm test
```

`npm test` runs real HTTP tests (`node --test`) against an ephemeral loopback port. The tests hit `/health`, an unknown route, and `/health` again, then close the server. HTTP behavior is exercised directly — no mocks.

## Build / syntax check

```sh
npm run build
```

`npm run build` syntax-checks all source JavaScript (`scripts/check-syntax.cjs`), which runs `node --check` over each `.cjs` source file.

## Routes

| Route              | Method | Status | Body                          |
| ------------------ | ------ | ------ | ----------------------------- |
| `/health`          | GET    | 200    | `{"status":"ok"}`             |
| any other route    | any    | 404    | JSON error (e.g. `{"error":"Not Found"}`) |

## Source to requirement mapping

| Requirement | Description                                                            | Source / test                              |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| FR1         | `GET /health` returns HTTP 200 and JSON `{"status":"ok"}`             | `src/app.cjs` · `test/health.test.cjs`     |
| FR2         | Unknown routes return HTTP 404 + JSON error; `/health` still answers  | `src/app.cjs` · `test/health.test.cjs`     |
| FR3         | `npm start` listens on `process.env.PORT` (default 3000); factory kept separate from startup | `src/server.cjs` · `src/app.cjs` · `test/startup.test.cjs` |
| NFR1        | `npm test` runs real HTTP tests on an ephemeral loopback port          | `test/health.test.cjs`                     |
| NFR2        | `npm run build` checks all source syntax; CommonJS `.cjs` conventions  | `scripts/check-syntax.cjs` · `package.json` · `test/startup.test.cjs` |

## Layout

```
package.json              scripts (start, test, build)
scripts/check-syntax.cjs  node --check over source files
src/app.cjs               handler + exported server factory (Application)
src/server.cjs            executable startup entry (Startup)
test/health.test.cjs      real ephemeral-port HTTP tests (Tests)
```