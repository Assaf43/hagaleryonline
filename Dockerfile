# One multi-target image (spec 9b.1). Targets:
#   app    - API (default command) and storefront SSR (compose sets the `web` and `migrate` commands)
#   caddy  - Caddy with the caddy-ratelimit plugin, the Caddyfile, the snippets and the admin static files
#   backup - the app files + postgresql-client-18 + age (the backup daemon)
# Build: docker build --target app --build-arg APP_VERSION=<git sha> -t nesto-app .
# Every base image is pinned to an exact version and the digest it was checked with.
# No secret is ever an ARG or ENV: every secret comes from the runtime environment.

# ---------- base: Node runtime with the OpenSSL that Prisma's schema engine detects ----------
FROM node:26.13.1-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
WORKDIR /app

# ---------- deps: npm ci from the lockfile (npm 11 runs only the install scripts in "allowScripts") ----------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/storefront/package.json apps/storefront/
COPY apps/admin/package.json apps/admin/
COPY libs/shared/models/package.json libs/shared/models/
COPY libs/shared/theme/package.json libs/shared/theme/
COPY libs/shared/ui/package.json libs/shared/ui/
COPY libs/shared/styles/package.json libs/shared/styles/
RUN npm ci --no-audit

# ---------- build: libs, Prisma client, the three apps, then drop dev dependencies ----------
FROM deps AS build
COPY . .
# prisma.config.ts reads DATABASE_URL; generate never connects, so a host-only placeholder is enough.
RUN npm run build:libs \
  && DATABASE_URL=postgresql://localhost/build npm run prisma:generate \
  && npm run build -w @hg/api -w @hg/storefront -w @hg/admin
# Workspace node_modules folders may be empty or absent; make them exist so the runtime COPY never fails.
RUN npm prune --omit=dev --no-audit \
  && mkdir -p apps/api/node_modules apps/storefront/node_modules

# ---------- runtime: the files shared by app and backup. No APP_VERSION here, so a new commit
# reuses these big layers and the backup apt layer when the sources did not change ----------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/libs/shared/models/package.json libs/shared/models/
COPY --from=build /app/libs/shared/models/dist libs/shared/models/dist
COPY --from=build /app/libs/shared/theme/package.json libs/shared/theme/
COPY --from=build /app/libs/shared/theme/dist libs/shared/theme/dist
COPY --from=build /app/apps/api/package.json /app/apps/api/prisma.config.ts apps/api/
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
# The seed and the localities script run with tsx and import the generated client source and the search-text helper.
COPY --from=build /app/apps/api/src/generated apps/api/src/generated
COPY --from=build /app/apps/api/src/catalog/search/search-text.ts apps/api/src/catalog/search/
COPY --from=build /app/apps/storefront/package.json apps/storefront/
COPY --from=build /app/apps/storefront/node_modules apps/storefront/node_modules
COPY --from=build /app/apps/storefront/dist apps/storefront/dist

# ---------- app: the runtime image ----------
FROM runtime AS app
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.revision=${APP_VERSION} \
  org.opencontainers.image.title="NESTO app"
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

# ---------- caddy: custom build with the rate-limit plugin ----------
FROM caddy:2.11.9-builder@sha256:cda07fe9d82728c7ac44d844306d435e98131423dc7b114f05a8a8ecfff94707 AS caddy-builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit@v0.1.1-0.20260612195517-5625512f24f6 --output /usr/bin/caddy

FROM caddy:2.11.9@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b AS caddy
ARG APP_VERSION=dev
LABEL org.opencontainers.image.revision=${APP_VERSION} \
  org.opencontainers.image.title="NESTO caddy"
COPY --from=caddy-builder /usr/bin/caddy /usr/bin/caddy
COPY deploy/caddy/*.caddy deploy/caddy/Caddyfile /etc/caddy/
COPY --from=build /app/apps/admin/dist/admin/browser /srv/admin

# ---------- backup: app + pg_dump 18 + age ----------
FROM runtime AS backup
# PGDG signing key: the download must hold exactly one primary key with this full fingerprint, and only
# that key is exported into the apt keyring. The build fails on any mismatch.
RUN set -eu; \
  pgdg_fpr=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8; \
  apt-get update; \
  apt-get install -y --no-install-recommends curl gnupg; \
  export GNUPGHOME="$(mktemp -d)"; \
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /tmp/pgdg.asc; \
  pubs="$(gpg --batch --show-keys --with-colons /tmp/pgdg.asc | grep -c '^pub:' || true)"; \
  if [ "$pubs" != 1 ]; then echo "PGDG key file holds $pubs primary keys, expected 1" >&2; exit 1; fi; \
  gpg --batch --quiet --import /tmp/pgdg.asc; \
  fpr="$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')"; \
  if [ "$fpr" != "$pgdg_fpr" ]; then echo "PGDG key fingerprint mismatch: $fpr" >&2; exit 1; fi; \
  gpg --batch --export "$pgdg_fpr" > /usr/share/keyrings/pgdg.gpg; \
  test -s /usr/share/keyrings/pgdg.gpg; \
  gpgconf --kill all; \
  rm -rf "$GNUPGHOME" /tmp/pgdg.asc; \
  echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends postgresql-client-18 age; \
  apt-get purge -y --auto-remove curl gnupg; \
  rm -rf /var/lib/apt/lists/*
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.revision=${APP_VERSION} \
  org.opencontainers.image.title="NESTO backup"
USER node
CMD ["node", "apps/api/dist/backup/main.js", "daemon"]
