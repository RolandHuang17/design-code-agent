'use strict';

/**
 * Space Fractions gateway — public edge (container port 3000).
 *
 * Responsibilities (space-fractions.md lines 15-24, 30-31):
 *   - GET /health -> 200 (orchestration/liveness probe).
 *   - Serve the plain browser UI (HTML/CSS/JS, no bundler) at "/".
 *   - Reverse-proxy authenticated API requests to the downstream services
 *     (game-service, question-service, user-service, admin-service), forwarding
 *     the Bearer OIDC access token verbatim so each service enforces its own
 *     authorization boundary.
 *   - Bounded downstream timeouts + error handling: a slow/unreachable service
 *     yields a 504/502, never an open socket.
 *   - Publish Prometheus metrics on GET /metrics.
 *   - Original GET /play backwards compatibility -> creates a practice game and
 *     returns { gameId } (Architecture_Documentation.md line 105).
 *
 * The gateway holds no domain state and performs no scoring/authorization of
 * its own. It computes the public browser origin from PUBLIC_ORIGIN (never a
 * hard-coded host:port) so Keycloak redirects work across remapped test ports.
 *
 * A reverse proxy with bounded timeouts is implemented on Node's built-in
 * `http` + global `fetch` (bounded via AbortController) rather than adding a
 * third-party proxy, keeping the runtime surface small and unit-testable —
 * injectable `routes`/`request` dependencies (see `buildApp`).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);

/** Per-downstream bounded timeout (ms) for API fan-out. */
const DOWNSTREAM_TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 10000);

/** Maximum forwarded request body (aligns with each service's `1mb` JSON limit). */
const MAX_BODY_BYTES = 1024 * 1024;

/** Default public-facing origin used for browser redirects/links. */
function publicOrigin() {
  return process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
}

/**
 * Build the browser-facing OIDC/client configuration served at /config.js.
 * The browser must never hard-code a Keycloak host:port, because the
 * acceptance harness remaps the identity-provider public origin and the
 * gateway public origin independently. Values derive from the environment:
 *
 *   - issuer: OIDC_ISSUER (public issuer URL), fallback OIDC_PUBLIC_ORIGIN +
 *     '/realms/space-fractions'.
 *   - redirectUri: PUBLIC_ORIGIN + '/' (where the browser actually reaches the
 *     gateway, and where Keycloak redirects the authorization code).
 *   - clientId: OIDC_CLIENT_ID (default 'space-fractions-client').
 */
function buildClientConfig(deps = {}) {
  const origin = (deps.publicOrigin || publicOrigin()).replace(/\/$/, '');
  const issuerEnv = deps.issuer || process.env.OIDC_ISSUER;
  const publicIssuer = deps.oidcPublicOrigin || process.env.OIDC_PUBLIC_ORIGIN;
  const issuer = issuerEnv
    ? issuerEnv.replace(/\/$/, '')
    : (publicIssuer ? `${publicIssuer.replace(/\/$/, '')}/realms/space-fractions` : `http://localhost:8080/realms/space-fractions`);
  return {
    issuer,
    clientId: deps.clientId || process.env.OIDC_CLIENT_ID || 'space-fractions-client',
    redirectUri: `${origin}/`,
    scope: deps.scope || process.env.OIDC_SCOPE || 'openid profile',
  };
}

function clientConfigJs(config) {
  return (
    `window.SPACE_FRACTIONS_CONFIG = ${JSON.stringify(config)};\n`
  );
}

/**
 * Read the static UI directory once (memoized). Returns a map of
 * relative-path -> { contentType, body } for every file under `public/`.
 */
function loadStaticAssets(staticDir) {
  const dir = staticDir || path.join(__dirname, '..', 'public');
  const assets = new Map();
  const walkAndRead = (base, relative) => {
    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(base, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkAndRead(abs, rel);
      } else {
        assets.set(`/${rel}`, {
          contentType: contentTypeFor(rel),
          body: fs.readFileSync(abs),
        });
      }
    }
  };
  walkAndRead(dir, '');
  return assets;
}

function contentTypeFor(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/**
 * Lightweight metrics registry (no external client required for the core
 * counters). Exposed as the standard Prometheus text format. Counters:
 *   http_requests_total{method,path,status}
 *   downstream_requests_total{service,status}
 *   downstream_timeouts_total{service}
 */
function createMetrics() {
  const counters = new Map();
  const inc = (name, labels) => {
    const key = `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`;
    counters.set(key, (counters.get(key) || 0) + 1);
  };
  return {
    inc,
    render() {
      const lines = [];
      for (const [key, value] of counters.entries()) {
        lines.push(`${key} ${value}`);
      }
      return `${lines.join('\n')}\n`;
    },
  };
}

/**
 * Message shape expected from a downstream service URL: either a base URL
 * string, or an object { base, service } where `service` is the metrics label.
 */
function resolveTarget(entry) {
  if (typeof entry === 'string') return { base: entry, service: entry };
  return { base: entry.base, service: entry.service };
}

/**
 * Build the gateway HTTP request handler.
 *
 * @param {object} [deps]
 * @param {Map<string,object>} [deps.assets]  static asset map (loadStaticAssets)
 * @param {object}            [deps.routes]  { prefix: string|{base,service} }
 *   mapping URL prefixes to downstream base URLs (e.g. { '/api/games': 'http://game-service:3001' }).
 * @param {function}          [deps.fetch]   fetch implementation (default global fetch)
 * @param {object}            [deps.metrics] metrics registry (default createMetrics())
 * @param {object}            [deps.logger]  logger (default console)
 * @returns {http.RequestListener}
 */
function buildApp(deps = {}) {
  const assets = deps.assets || loadStaticAssets();
  const routes = deps.routes || defaultRoutes();
  const fetchImpl = deps.fetch || globalThis.fetch;
  const metrics = deps.metrics || createMetrics();
  const log = deps.logger || console;
  const origin = deps.publicOrigin || publicOrigin();

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('request body too large');
        err.status = 413;
        throw err;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function respond(res, status, headers, body) {
    res.writeHead(status, headers);
    res.end(body);
  }

  function json(res, status, obj) {
    respond(
      res,
      status,
      { 'content-type': 'application/json; charset=utf-8' },
      JSON.stringify(obj),
    );
  }

  /**
   * Forward an incoming request to the selected downstream target with a
   * bounded timeout. Returns { status, headers, body } on success; throws on
   * timeout (504) or refusal (502).
   */
  async function forward(req, target, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNSTREAM_TIMEOUT_MS);
    const url = new URL(req.url, target.base);
    try {
      const upstream = await fetchImpl(url.toString(), {
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] || 'application/json',
          // Forward the Bearer token verbatim so downstream services authorize.
          ...(req.headers.authorization
            ? { authorization: req.headers.authorization }
            : {}),
          accept: 'application/json',
        },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        signal: controller.signal,
      });
      const resBody = await upstream.arrayBuffer();
      return {
        status: upstream.status,
        headers: upstream.headers,
        body: Buffer.from(resBody),
      };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const e = new Error(`downstream timeout: ${target.service}`);
        e.status = 504;
        throw e;
      }
      const e = new Error(`downstream unavailable: ${target.service}`);
      e.status = 502;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function forwardableHeaders(headers) {
    const out = { 'content-type': 'application/json; charset=utf-8' };
    for (const key of ['content-type', 'cache-control', 'etag']) {
      if (headers && headers.get && headers.get(key)) out[key] = headers.get(key);
    }
    return out;
  }

  async function handle(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;
    const start = Date.now();

    try {
      // Liveness/readiness.
      if (pathname === '/health') {
        metrics.inc('http_requests_total', { method: 'GET', path: '/health', status: 200 });
        return json(res, 200, { status: 'ok', service: 'gateway' });
      }

      // Prometheus scrape endpoint.
      if (pathname === '/metrics') {
        metrics.inc('http_requests_total', { method: 'GET', path: '/metrics', status: 200 });
        return respond(res, 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }, metrics.render());
      }

      // Original GET /play compatibility -> create a practice game, return gameId.
      if (pathname === '/play' && req.method === 'GET') {
        const gameTarget = resolveTarget(routes['/api/games']);
        const body = Buffer.from('{}');
        const { status, headers, body: resBody } = await forward(
          { ...req, url: '/api/games', method: 'POST' },
          gameTarget,
          body,
        );
        let gameId = null;
        try {
          const created = JSON.parse(resBody.toString('utf8'));
          gameId = created.id;
        } catch {
          /* downstream already errored */
        }
        const finalStatus = status < 400 && gameId ? 200 : status;
        metrics.inc('downstream_requests_total', { service: gameTarget.service, status });
        metrics.inc('http_requests_total', { method: 'GET', path: '/play', status: finalStatus });
        if (gameId) return json(res, finalStatus, { gameId });
        return respond(res, status, forwardableHeaders(headers), resBody);
      }

      // Static UI (served at "/", plus assets referenced by index.html).
      if (req.method === 'GET' || req.method === 'HEAD') {
        const assetPath = pathname === '/' ? '/index.html' : pathname;
        const asset = assets.get(assetPath);
        if (asset) {
          metrics.inc('http_requests_total', { method: req.method, path: pathname, status: 200 });
          const headers = { 'content-type': asset.contentType, 'cache-control': 'no-cache' };
          return respond(res, 200, headers, req.method === 'HEAD' ? undefined : asset.body);
        }
      }

      // API fan-out: longest matching prefix.
      const matching = Object.keys(routes)
        .filter((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
        .sort((a, b) => b.length - a.length)[0];
      if (matching) {
        const target = resolveTarget(routes[matching]);
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
        const { status, headers, body: resBody } = await forward(req, target, body);
        metrics.inc('downstream_requests_total', { service: target.service, status });
        metrics.inc('http_requests_total', { method: req.method, path: pathname, status });
        return respond(res, status, forwardableHeaders(headers), resBody);
      }

      metrics.inc('http_requests_total', { method: req.method, path: pathname, status: 404 });
      return json(res, 404, { error: 'not_found' });
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      log.error(`gateway error on ${req.method} ${pathname}`, err.message);
      metrics.inc('http_requests_total', { method: req.method, path: pathname, status });
      if (status === 504) {
        const serviceLabel = (err.service || 'unknown');
        metrics.inc('downstream_timeouts_total', { service: serviceLabel });
      }
      return json(res, status, { error: status === 504 ? 'gateway_timeout' : status === 502 ? 'bad_gateway' : 'internal_error' });
    }
  }

  return handle;
}

/** Default downstream routes resolved from env with container defaults. */
function defaultRoutes() {
  return {
    '/api/games': process.env.GAME_SERVICE_URL || 'http://game-service:3001',
    '/api/questions': process.env.QUESTION_SERVICE_URL || 'http://question-service:3002',
    '/api/users': process.env.USER_SERVICE_URL || 'http://user-service:3003',
    '/users': process.env.USER_SERVICE_URL || 'http://user-service:3003',
    '/auth': process.env.USER_SERVICE_URL || 'http://user-service:3003',
    '/api/admin': process.env.ADMIN_SERVICE_URL || 'http://admin-service:3004',
  };
}

/**
 * Start the gateway HTTP listener (kept alive until SIGTERM/SIGINT).
 * The listener stays alive independently of downstream availability, so the
 * startup probe passes even before backing services are ready.
 */
function startServer(app, port) {
  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`gateway listening on :${port}`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

// Direct execution only (not on import, so tests can require buildApp).
if (require.main === module) {
  startServer(buildApp(process.env.GATEWAY_STATIC_DIR ? {
    assets: loadStaticAssets(process.env.GATEWAY_STATIC_DIR),
  } : {}), PORT);
}

module.exports = {
  buildApp,
  loadStaticAssets,
  createMetrics,
  defaultRoutes,
  startServer,
  publicOrigin,
  contentTypeFor,
};