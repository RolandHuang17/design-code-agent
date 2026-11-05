# Space Fractions User Service
# Build context: repository root (needed for npm workspaces + shared package)
FROM node:22-alpine AS base

WORKDIR /app

COPY package.json package-lock.json* ./
COPY shared/package.json shared/package.json
COPY gateway/package.json gateway/package.json
COPY services/game-service/package.json services/game-service/package.json
COPY services/question-service/package.json services/question-service/package.json
COPY services/user-service/package.json services/user-service/package.json
COPY services/admin-service/package.json services/admin-service/package.json

RUN npm install --omit=dev

COPY shared/src shared/src
COPY services/user-service/src services/user-service/src

ENV NODE_ENV=production

EXPOSE 3003 9093

USER node

CMD ["node", "services/user-service/src/index.js"]