# Space Fractions API Gateway
# Build context: repository root (needed for npm workspaces + shared package)
FROM node:22-alpine AS base

WORKDIR /app

# Copy workspace manifests first for dependency caching
COPY package.json package-lock.json* ./
COPY shared/package.json shared/package.json
COPY gateway/package.json gateway/package.json
COPY services/game-service/package.json services/game-service/package.json
COPY services/question-service/package.json services/question-service/package.json
COPY services/user-service/package.json services/user-service/package.json
COPY services/admin-service/package.json services/admin-service/package.json

# Install all workspace dependencies (no optional native builds needed)
RUN npm install --omit=dev --workspaces=false \
    && npm install --omit=dev

# Copy source for shared + gateway
COPY shared/src shared/src
COPY gateway/src gateway/src
COPY gateway/public gateway/public

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000 9095

USER node

CMD ["node", "gateway/src/index.js"]