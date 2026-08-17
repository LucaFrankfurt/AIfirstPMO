# Kolibri — one image, one process, one volume.
#
# The server runs TypeScript directly (Node ≥ 22.18 strips types natively) and
# stores everything in SQLite, so the runtime stage carries zero npm
# dependencies: only the web build needs a toolchain.

# ---------------------------------------------------------------- build web
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so the dependency layer is cached across code changes.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/mcp/package.json packages/mcp/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build -w @kolibri/web

# ------------------------------------------------------------------ runtime
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    KOLIBRI_DATA_DIR=/data \
    KOLIBRI_WEB_DIR=/app/packages/web/dist \
    PORT=4000

WORKDIR /app
RUN apk add --no-cache tini wget && mkdir -p /data && chown -R node:node /data

COPY --chown=node:node package.json ./
COPY --chown=node:node packages/shared ./packages/shared
COPY --chown=node:node packages/server/package.json ./packages/server/package.json
COPY --chown=node:node packages/server/src ./packages/server/src
COPY --chown=node:node packages/mcp ./packages/mcp
COPY --from=build --chown=node:node /app/packages/web/dist ./packages/web/dist
# Workspace links so `@kolibri/shared` resolves without a package manager.
RUN mkdir -p node_modules/@kolibri \
    && ln -s /app/packages/shared node_modules/@kolibri/shared \
    && ln -s /app/packages/server node_modules/@kolibri/server \
    && chown -R node:node /app/node_modules

USER node
VOLUME ["/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "packages/server/src/index.ts"]
