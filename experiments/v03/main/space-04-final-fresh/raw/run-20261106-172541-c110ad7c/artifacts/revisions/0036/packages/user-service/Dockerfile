# Space Fractions user-service image (OIDC identity resolution + authorization,
# port 3003).
#
# Build context is the repository root (see compose.yaml). The user service is
# a downstream Node service behind the gateway: it verifies Bearer OIDC access
# tokens (issuer/audience/JWKS), maps the verified `sub` claim to a numeric
# internal user id via the `users` table (UNIQUE subject), and exposes
# owner/admin authorization helpers consumed by the game-service and
# admin-service. All configuration comes from environment variables
# (DATABASE_URL, OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URI, OIDC_ADMIN_ROLE,
# USER_SERVICE_PORT) — nothing is baked into the image.

FROM node:22-alpine

WORKDIR /usr/src/app

# Install production dependencies first for a stable, cached layer. The root
# package.json declares the user-service runtime dependencies (express for the
# HTTP layer, pg for PostgreSQL persistence, jose for OIDC/JWKS verification).
# The service's relative require of ../../shared/oidc must resolve against the
# copied tree, so this install must not be a no-op.
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts || true

# Copy the full tree so the relative require ../../shared/oidc under src/shared
# resolves at runtime (see packages/user-service/src/index.js
# buildProductionDeps).
COPY . .

ENV NODE_ENV=production
ENV USER_SERVICE_PORT=3003

EXPOSE 3003

CMD ["node", "packages/user-service/src/index.js"]