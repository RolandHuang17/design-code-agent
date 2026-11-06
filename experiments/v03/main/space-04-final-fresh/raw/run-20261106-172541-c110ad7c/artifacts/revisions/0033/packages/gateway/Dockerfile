# Space Fractions gateway image (public edge, container port 3000).
#
# Build context is the repository root (see compose.yaml). Runtime mirrors the
# gateway service in compose: it serves the browser UI at "/", proxies API
# requests to downstream services (game/question/user/admin), and exposes
# /health and /metrics. All configuration comes from environment variables —
# nothing (ports, redirects, tokens) is baked into the image.

FROM node:22-alpine

WORKDIR /usr/src/app

# Install production dependencies first for a stable, cached layer. The root
# package.json declares any runtime deps for the gateway; the gateway itself
# uses only Node built-ins (http/fs/path), so this step may be a no-op when a
# lockfile is absent. It is kept to stay correct if a runtime dependency is
# added without changing this build topology.
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts || true

# Copy only what the gateway needs at runtime. The gateway serves static UI
# from packages/gateway/public and requires packages/gateway/src/index.js as
# its entrypoint. Copying the full tree keeps any future shared requires (e.g.
# src/*) available without an additional COPY rule.
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

# Bind-mounted static assets can override the default packaged UI, matching the
# GATEWAY_STATIC_DIR escape hatch in packages/gateway/src/index.js.
EXPOSE 3000

CMD ["node", "packages/gateway/src/index.js"]