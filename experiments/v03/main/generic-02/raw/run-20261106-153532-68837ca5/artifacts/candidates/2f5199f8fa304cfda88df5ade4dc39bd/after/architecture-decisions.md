# Architecture decisions — Temperature converter

## Source of truth
The design is a single, small, browser-based temperature converter (Architecture_Documentation.md) with one PlantUML view (Architecture_View.md). It is explicitly **not** a microservice, and requires no database, identity service, message queue, Docker, OpenAPI specification or cloud deployment. These exclusions are respected; no Compose, gateway, database or proto files are generated.

## Module convention (AD-1)
**Decision:** Use ESM (`"type": "module"`).
**Rationale:** The design requires a *consistent* CommonJS or ESM convention and Node.js 22 fully supports ESM with zero transpilation. ESM is the default modern choice for new small apps.
**Status:** Assumption (the design permits either; ESM is selected, not mandated).

## Separation of concerns (AD-2)
**Decision:** Three cohesive modules:
- `src/convert.js` — pure conversion + validation, no I/O (the "Pure temperature conversion" component in the view).
- `src/app.js` — HTTP routing/request handler ("HTTP application"), imports convert and maps errors to HTTP 400/200.
- `src/server.js` — process bootstrap ("npm start"), reads `process.env.PORT` and starts the server.
- `public/index.html` — the "Browser page" (UI).
**Rationale:** NFR1 mandates conversion logic be testable without a running server; the view explicitly separates Convert from HTTP from UI.

## Dependencies (AD-3)
**Decision:** Zero runtime npm dependencies. Tests use Node's built-in `node:test`/`node:assert`; `npm run build` uses `node --check` for syntax validation.
**Rationale:** The app has no external runtime services; the design permits pinned dependencies "if needed", and none are needed for this scope.

## Validation model (AD-4)
**Decision:** Input validation lives in `src/convert.js` (`validateInput`) and is invoked by the HTTP layer. Rejections are: missing `value`/`from`/`to`; `value` not a finite number or is a boolean; `from`/`to` not in `{C,F,K}`; value below absolute zero for its source unit (including same-unit conversions). Absolute zero: `-273.15` C, `-459.67` F, `0` K.
**Boundary tolerance:** A relative tolerance `EPSILON = 1e-9` is allowed at absolute-zero boundaries to satisfy FR4's "insignificant floating-point error".
**Status:** Boundary tolerance is an assumption (no concrete epsilon stated in the design).

## Conversion algorithm (AD-5)
**Decision:** Convert through Celsius. `C = (F - 32) * 5 / 9` and `K = C + 273.15`; the inverse relationships are derived from these. Same-unit conversion returns the input value unchanged (after validation). No rounding to integer is applied to the API result.

## Statelessness (AD-6)
**Decision:** No state is stored across requests; every POST re-validates its own body. This matches the design's explicit "stateless" decision and eliminates any persistence layer.

## Testing strategy (AD-7)
**Decision:** `npm test` runs `node --test`, which discovers `test/convert.test.js` (pure logic, no server) and `test/app.test.js` (handler injected into an in-process server bound to ephemeral port 0). No external PostgreSQL/Redis/provider is required. `npm run build` runs `node --check` over all source files.

## Verification approach
- `npm run build` proves syntax.
- `npm test` proves conversion correctness, boundary handling, and HTTP status/error mapping without external services.
- `npm start` (PORT default 3000) exposes GET `/`, POST `/api/convert`, and GET `/health`.