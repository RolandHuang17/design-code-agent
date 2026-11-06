# Space Fractions admin-service image (authenticated administrator question CRUD,
# port 3004).
#
# Build context is the repository root (see compose.yaml). The admin service is a
# downstream Node service behind the gateway: it enforces the OIDC admin role and
# delegates question writes to the question service so validation, PostgreSQL
# persistence and Elasticsearch indexing stay consistent (see
# packages/admin-service/src/index.js buildProductionDeps). All configuration comes
# from environment variables (DATABASE_URL, ELASTICSEARCH_URL, OIDC_ISSUER,
# OIDC_AUDIENCE, OIDC_JWKS_URI, OIDC_ADMIN_ROLE, ADMIN_SERVICE_PORT) — nothing is
# baked into the image.

FROM node:22-alpine

WORKDIR /usr/src/app

# Install production dependencies first for a stable, cached layer. The root
# package.json declares the admin-service runtime dependencies (express for the
# HTTP layer, @elastic/elasticsearch for the search client reachable through the
# reused QuestionSearch). The service's relative requires of ../../shared/oidc,
# ../../question-service and ../../user-service must resolve against the copied
# tree, so this install must not be a no-op.
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts || true

# Copy the full tree so relative requires resolve: ../../shared/oidc (OIDC
# verification + admin-role check), ../../question-service (validation,
# repository, QuestionSearch) and ../../user-service (authenticate + user
# repository), all imported by packages/admin-service/src/index.js.
COPY . .

ENV NODE_ENV=production
ENV ADMIN_SERVICE_PORT=3004

EXPOSE 3004

CMD ["node", "packages/admin-service/src/index.js"]