# Temperature converter

## Scope
Build a small browser-based temperature converter. This is a single Node.js 22 application, not a microservice application. No database, identity service, message queue, Docker, OpenAPI specification or cloud deployment is required. Deliver package.json, source files, real unit tests, a working page, README and source-to-code/test traceability.

## Requirements
FR1: GET / serves an HTML page with a numeric input, source and destination unit selectors, submit button, result and visible error feedback.
FR2: POST /api/convert accepts JSON {"value": number, "from": "C"|"F"|"K", "to": "C"|"F"|"K"}. Return HTTP 200 JSON {"value": number,"unit": destination unit}. Do not round the API value to an integer.
FR3: Use C = (F - 32) * 5 / 9 and K = C + 273.15. Same-unit conversion preserves the value. Negative Celsius and Fahrenheit values are valid above absolute zero.
FR4: Reject missing fields, nonnumeric values, booleans, unsupported units, malformed JSON and temperatures below absolute zero with HTTP 400 and JSON {"error": nonempty string}. Reject below-zero values even for a same-unit conversion. The exact boundary is -273.15 C, -459.67 F and 0 K; allow insignificant floating-point error at these boundaries.
FR5: GET /health returns HTTP 200 JSON {"status":"ok"}.
NFR1: Keep conversion logic separate from HTTP handling and test it without a running server. npm test must execute meaningful tests; npm run build must check source syntax.
NFR2: npm start starts the server using process.env.PORT (default 3000). The application has no external runtime services. Document install/start/test instructions and limitations.

## Design decisions
The application is stateless. Keep a consistent CommonJS or ESM module convention. Use pinned dependency versions if dependencies are needed. No API key is needed by the generated application.
