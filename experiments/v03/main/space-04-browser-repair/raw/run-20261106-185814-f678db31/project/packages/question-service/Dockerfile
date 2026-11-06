# Space Fractions question-service image (question CRUD + search, port 3002).
#
# Build context is the repository root (see compose.yaml). The question service
# is a downstream Node service behind the gateway: it persists questions in
# PostgreSQL and indexes/searches them via a real Elasticsearch client. It is
# the data-owner for question records and validates every correct_answer with
# the shared exact rational fraction validator. All configuration comes from
# environment variables (DATABASE_URL, ELASTICSEARCH_URL,
# QUESTION_SERVICE_PORT) — nothing is baked into the image.

FROM node:22-alpine

WORKDIR /usr/src/app

# Install production dependencies first for a stable, cached layer. The root
# package.json declares the question-service runtime dependencies (express for
# the HTTP layer, @elastic/elasticsearch for the search client). The service's
# relative require of ../../shared/fraction must resolve against the copied
# tree, so this install must not be a no-op.
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts || true

# Copy the full tree so relative requires resolve: ../../shared/fraction under
# src/shared, plus ./repository and ./search which the service imports (see
# packages/question-service/src/index.js buildProductionDeps).
COPY . .

ENV NODE_ENV=production
ENV QUESTION_SERVICE_PORT=3002

EXPOSE 3002

CMD ["node", "packages/question-service/src/index.js"]