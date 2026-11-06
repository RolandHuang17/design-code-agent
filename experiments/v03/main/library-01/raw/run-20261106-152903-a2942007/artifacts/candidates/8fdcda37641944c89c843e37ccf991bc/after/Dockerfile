# Build stage: install pinned production dependencies.
FROM node:22-alpine AS build
WORKDIR /app

# The host generates the root package-lock.json during the install check.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage: minimal Node image running the gateway.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

EXPOSE 3000

USER node

CMD ["node", "src/server.js"]