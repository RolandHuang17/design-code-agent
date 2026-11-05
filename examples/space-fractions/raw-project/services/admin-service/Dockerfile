# Space Fractions Admin Service
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
COPY services/admin-service/src services/admin-service/src
# admin-service routes import the shared question search module from
# services/question-service/src/search.js, so bake that source in too.
COPY services/question-service/src services/question-service/src

ENV NODE_ENV=production

EXPOSE 3004 9094

USER node

CMD ["node", "services/admin-service/src/index.js"]