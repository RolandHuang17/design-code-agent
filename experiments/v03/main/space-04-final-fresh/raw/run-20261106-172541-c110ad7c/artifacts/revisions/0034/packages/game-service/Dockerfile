# Space Fractions game-service image (session lifecycle + scoring, port 3001).
#
# Build context is the repository root (see compose.yaml). The game service is
# a downstream Node service behind the gateway: it persists game state in
# PostgreSQL, reads questions from the question-service repository, maps OIDC
# subject strings to numeric owner ids via the user-service repository, and
# emits score events to RabbitMQ. All configuration comes from environment
# variables (DATABASE_URL, RABBITMQ_URL, OIDC_ISSUER, OIDC_AUDIENCE,
# OIDC_JWKS_URI, GAME_SERVICE_PORT) — nothing is baked into the image.

FROM node:22-alpine

WORKDIR /usr/src/app

# Install production dependencies first for a stable, cached layer. The root
# package.json declares shared runtime dependencies (express, pg, amqplib,
# jose). The service's relative requires (../../shared/*, question-service and
# user-service repositories) resolve against package.json in the copied tree,
# so this install must not be a no-op.
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts || true

# Copy the full tree so relative requires resolve: ../../shared/oidc and
# ../../shared/fraction under src/shared, plus the question/user repositories
# the game service imports at runtime (see packages/game-service/src/index.js
# buildProductionDeps).
COPY . .

ENV NODE_ENV=production
ENV GAME_SERVICE_PORT=3001

EXPOSE 3001

CMD ["node", "packages/game-service/src/index.js"]