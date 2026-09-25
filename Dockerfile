# Discovery Platform — production image for the fase 2.3 online test deployment.
#
# Builds every workspace this app needs (discovery-core, discovery-db, discovery-client,
# domains/vacancies, apps/web, apps/api — the exact same `npm run build` CI already runs), then
# assembles a minimal runtime image that starts a single Node/Express process. That one process
# serves both the API (/api/v1/*) and the built Web App (everything else, with an index.html
# fallback for client-side routes) on the same origin — see apps/api/src/server.ts's `webDistDir`
# option — so the session cookie is always first-party, no cross-origin cookie complexity.
#
# The same image also runs the database migration step (packages/discovery-db/dist/migrate.js),
# as a separate Cloud Run Job with its command overridden — see docs/deployment.md — rather than
# ever running migrations automatically on every web container start.

FROM node:24-slim AS build
WORKDIR /app

# The lockfile is authoritative — `npm ci` refuses to proceed if package.json and
# package-lock.json disagree, catching a missed `npm install` before it ever reaches an image.
COPY . .
RUN npm ci

# VITE_API_URL=/api/v1 (a same-origin relative path, not an absolute http://... URL) is what
# makes the built Web App call the API on its own origin instead of a separate one — see
# packages/discovery-client's own doc comment on ApiClientOptions.baseUrl. VITE_ENV_LABEL shows
# the small "Testomgeving" badge (see apps/web/src/components/layout/app-layout.tsx) so this
# deployment can never be mistaken for a later production environment. Vite inlines both at
# build time; changing either later means rebuilding the image, not just restarting a container.
ARG VITE_API_URL=/api/v1
ARG VITE_ENV_LABEL=Testomgeving
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_ENV_LABEL=${VITE_ENV_LABEL}
RUN npm run build

# Devdependencies (typescript, vite, vitest, ...) were only needed to produce the dist/ output
# above — drop them now so the runtime image below never inherits them.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# The web dist this image bakes in — see server.ts: only serves static files/SPA fallback when
# this is set, so local development (no WEB_DIST_DIR) is completely unaffected.
ENV WEB_DIST_DIR=/app/apps/web/dist

# `ps` must exist at runtime: Crawlee's BasicCrawler (the opt-in `crawlee` crawl engine, see
# docs/crawler-engines.md) starts an AutoscaledPool whose system measurements run `ps` on Linux;
# node:24-slim ships without it, and crawler.run() then fails with `spawn ps ENOENT` before the
# first request. Runtime stage only — the build stage does not need it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*
# Build-time guard: fail the image build (not a later crawl) if `ps` ever goes missing again.
RUN command -v ps >/dev/null && ps -ef >/dev/null

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

COPY --from=build /app/packages/discovery-core/package.json ./packages/discovery-core/package.json
COPY --from=build /app/packages/discovery-core/dist ./packages/discovery-core/dist
COPY --from=build /app/packages/discovery-db/package.json ./packages/discovery-db/package.json
COPY --from=build /app/packages/discovery-db/dist ./packages/discovery-db/dist
# migrate.js reads these .sql files from disk at runtime — they are not compiled into dist/, so
# the migration job (see docs/deployment.md) would fail without them.
COPY --from=build /app/packages/discovery-db/migrations ./packages/discovery-db/migrations
COPY --from=build /app/domains/vacancies/package.json ./domains/vacancies/package.json
COPY --from=build /app/domains/vacancies/dist ./domains/vacancies/dist
COPY --from=build /app/domains/tenders/package.json ./domains/tenders/package.json
COPY --from=build /app/domains/tenders/dist ./domains/tenders/dist
COPY --from=build /app/domains/companies/package.json ./domains/companies/package.json
COPY --from=build /app/domains/companies/dist ./domains/companies/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

EXPOSE 8080
USER node

# The migration job (see docs/deployment.md) runs this same image with its command overridden to
# `node packages/discovery-db/dist/migrate.js` — no second Dockerfile needed.
CMD ["node", "apps/api/dist/server.js"]
