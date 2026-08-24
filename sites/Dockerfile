# One image, either site.
#
#   docker build --build-arg SITE=docs -f sites/Dockerfile -t kolibri-docs sites
#   docker build --build-arg SITE=demo -f sites/Dockerfile -t kolibri-demo sites
#
# The build context is `sites/` rather than a single site's folder, so both can
# share one nginx config and one Dockerfile. They are the same shape of thing —
# an Astro project that renders to static files — and two copies of this would
# drift the moment one of them got a fix.
#
# The runtime stage carries nginx and the rendered HTML. Node is in the build
# stage only; nothing here executes JavaScript on the server, because there is
# no server-side JavaScript to execute.

ARG SITE=docs

# ------------------------------------------------------------------- build
FROM node:22-alpine AS build
ARG SITE
WORKDIR /site

# The manifest first, so the dependency layer survives a content change. A
# lockfile is copied when there is one and skipped when there is not — the `*`
# is what makes that legal in a COPY.
COPY ${SITE}/package.json ${SITE}/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY ${SITE}/ ./
# `csp-seal.mjs` runs after `astro build` (see the site's build script) and
# hashes the inline scripts Astro's own CSP pass missed. It lives one level up
# because both sites run it.
COPY csp-seal.mjs ../csp-seal.mjs

# Where the buttons point. Every one of these is inlined into the HTML at build
# time, which is why none of them may ever hold a secret.
ARG PUBLIC_APP_URL
ARG PUBLIC_DOCS_URL
ARG PUBLIC_DEMO_URL
ARG PUBLIC_REPO_URL
ARG PUBLIC_DEMO_EMAIL
ARG PUBLIC_DEMO_PASSWORD
ARG PUBLIC_RESET_EVERY
ENV PUBLIC_APP_URL=${PUBLIC_APP_URL} \
    PUBLIC_DOCS_URL=${PUBLIC_DOCS_URL} \
    PUBLIC_DEMO_URL=${PUBLIC_DEMO_URL} \
    PUBLIC_REPO_URL=${PUBLIC_REPO_URL} \
    PUBLIC_DEMO_EMAIL=${PUBLIC_DEMO_EMAIL} \
    PUBLIC_DEMO_PASSWORD=${PUBLIC_DEMO_PASSWORD} \
    PUBLIC_RESET_EVERY=${PUBLIC_RESET_EVERY}

RUN npm run build

# ----------------------------------------------------------------- runtime
FROM nginx:1.31-alpine AS runtime

COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /site/dist /usr/share/nginx/html

# nginx's own unprivileged user, and the two paths it writes to at runtime.
RUN mkdir -p /tmp && chown -R nginx:nginx /usr/share/nginx/html /tmp
USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
