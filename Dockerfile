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

# The maintenance commands, as one word. `docker compose exec kolibri kolibri
# doctor` is what the documentation says, so it had better be what the image has.
RUN printf '#!/bin/sh\nexec node --experimental-sqlite --disable-warning=ExperimentalWarning /app/packages/server/src/cli.ts "$@"\n' \
      > /usr/local/bin/kolibri \
    && chmod +x /usr/local/bin/kolibri

# The two scripts the public demo runs, and nothing else does.
#
# In the image rather than bind-mounted from a checkout, because a bind mount
# is a host path — and a host path is the one thing a platform that deploys
# from a git URL cannot be relied on to hand you. `docker-compose.demo.yml`
# mounted these over `/app/scripts`, a directory this image did not have, and
# was the only stack here that could not be deployed that way.
#
# Inert in an ordinary image. The ENTRYPOINT below is tini and the CMD is the
# server; neither mentions these, and nothing runs them unless a compose file
# puts the reset loop in front, which only the demo does. Root-owned and
# read-only, so the `node` user the server runs as cannot rewrite the thing
# that wipes the database — which is more than the `:ro` mount they replace
# could promise.
COPY scripts/demo-entrypoint.sh scripts/demo-extras.mjs ./scripts/
RUN chmod 555 ./scripts/demo-entrypoint.sh ./scripts/demo-extras.mjs

USER node
VOLUME ["/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "packages/server/src/index.ts"]
