# syntax=docker/dockerfile:1

# Library borrowing gateway — Node.js 22 runtime.
# The host generates package-lock.json; `npm ci` installs from it during build.
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Install dependencies first so source changes do not bust the layer cache.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy the installed dependency tree and application sources.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Non-root runtime user (the app listens on 3000, no privileged ports needed).
USER node

EXPOSE 3000

# Container health: probe the gateway's own /health endpoint. The values are
# deliberately conservative to tolerate PostgreSQL bootstrapping at startup.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
    CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]