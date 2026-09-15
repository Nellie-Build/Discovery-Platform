# Discovery Platform

Discovery Platform is an extensible discovery and lead intelligence engine that can gather
information from websites, text and images, then structure, enrich, score and deduplicate it,
persist it in PostgreSQL, and serve it over an HTTP API and a web app.

**This is a working first product slice, not a finished one.** Registration, workspaces,
starting a Discovery run and browsing its results all work end to end — see "What's next" below
for what is deliberately still missing (billing, teams beyond owner/member, white-labeling, and
the `companies`/`housing`/`candidates` domain modules).

## Core capabilities

- **Website crawling** — robots.txt/sitemap-aware, rate-limited, with an injectable per-page
  extraction callback and link-priority ranking.
- **Contact extraction** — e-mail/phone/WhatsApp/Instagram/Facebook, with caller-supplied
  normalizers (this package has no built-in numbering-plan or country knowledge).
- **Domain-specific extraction** — structured-data (JSON-LD) and plain-text/label extraction,
  composed through a small `DomainConfig` seam.
- **Scoring** — a generic "sum weighted signals, clamp, decide" engine; each domain supplies its
  own rules.
- **Deduplication** — a generic "block by shared key or nearby coordinates, sum matched-signal
  points, decide" engine; each domain supplies its own signals.
- **Gemini Vision** — a generic "call the model with your prompt/schema, hand the raw JSON to
  your own validator" engine; each domain supplies its own schema, prompt and parser, and the
  model's output is never trusted directly.
- **Extensible domain modules** — every capability above is domain-neutral by construction (see
  `docs/architecture.md`); a domain module is the only place business rules live.
- **PostgreSQL persistence** — a domain-neutral `Workspace → Project → Discovery Run → Record →
  Sources/Contacts` schema (`packages/discovery-db`); no domain ever gets its own SQL column.
- **HTTP API** — `apps/api`, prefixed at `/api/v1`; composes the engine, a domain registry, and
  the database, with no domain-specific parsing anywhere in a route.
- **Real authentication & workspace isolation** — cookie/session-based login (Passport +
  express-session + connect-pg-simple + bcryptjs; no token ever touches localStorage), enforced
  centrally so a user only ever reaches a workspace, project, run or record they are a member of
  — see `docs/architecture.md`'s "Authentication and workspace isolation" section.
- **Web App** — `apps/web` (React + TypeScript + Vite + Tailwind): register/login, a dashboard,
  projects, starting and following a Discovery run, and a domain-aware record list/detail view
  that always shows provenance (source + when it was found), never just raw JSON.

## Available domain modules

- **Vacancies** (`domains/vacancies`) — the first, fully working reference implementation.
  Extracts job postings (structured data + plain text), scores page completeness, detects
  duplicate listings, and reads vacancy posters/flyers via Vision.

**Planned, not yet built:** Companies, Housing, Candidates.

## Repository layout

```
Discovery-Platform/
├── packages/
│   ├── discovery-core/       The domain-neutral engine (crawler, contacts, scoring, dedupe, Vision)
│   ├── discovery-db/         PostgreSQL persistence — Users/Workspace → Project → Run → Record → Sources/Contacts
│   └── discovery-client/     Small typed fetch client the Web App uses to call the API (cookie-based, no token storage)
├── domains/
│   └── vacancies/            The first reference domain module
├── apps/
│   ├── api/                  The HTTP API (/api/v1) — auth/session, workspace isolation, domain registry, discovery-db
│   └── web/                  The Web App (React + Vite + Tailwind) — register/login, projects, runs, records
├── examples/
│   ├── basic-discovery/      Minimal generic crawler usage, no domain module at all
│   └── vacancy-discovery/    The vacancies domain module wired into a real crawl
├── docs/
│   └── architecture.md       The Source → Core → Domain Module → Record → Workflow principle, plus auth/isolation
├── scripts/
│   └── local-postgres.mjs    Windows-friendly embedded Postgres launcher (no Docker needed)
├── docker-compose.yml         PostgreSQL for local development (any platform)
├── .env.example               Copy to .env — GEMINI_*, POSTGRES_*, SESSION_SECRET, WEB_ORIGIN, API_* — never commit .env
└── package.json                Root npm workspace
```

## Getting started

Requires Node.js 24+ and a PostgreSQL server (see "Local development" below).

```sh
npm install
docker compose up -d      # starts PostgreSQL (or: npm run db:local:up on Windows without Docker)
npm run db:migrate        # applies packages/discovery-db/migrations
npm run build              # builds every package, domain module, app and the Web App's production bundle
npm run typecheck           # tsc --noEmit across every TypeScript package, including apps/web
npm test                    # tests every package (uses an embedded PGlite database — no live server needed)
npm run dev                  # starts the API (http://127.0.0.1:3000/api/v1) AND the Web App (http://localhost:5173)
```

Open `http://localhost:5173`, register an account, and you land in your first (automatically
created) workspace — create a Vacancies project, start a Discovery run against a real
`https://.../werken-bij`-style URL, and its results appear once the run completes.

Individual workspace commands also work directly, e.g. `npm run test -w packages/discovery-core`,
`npm run dev:api` / `npm run dev:web` to run just one side, or `npm run crawl --
https://example.com` from inside `examples/basic-discovery`.

### Local development

Copy `.env.example` to `.env` first. Two ways to get a local PostgreSQL server:

- **Docker (any platform):** `docker compose up -d` starts a `postgres:16-alpine` container
  using the `POSTGRES_*` values from `.env`.
- **Windows without Docker:** `npm run db:local:up` starts an embedded, portable PostgreSQL
  binary under `data/.postgres/` (gitignored) — no system install, no admin rights. `npm run
  db:local:down` stops it, `npm run db:local:status` checks it.

Either way, `npm run db:migrate` then applies every migration in `packages/discovery-db/migrations`.

The API also needs a `SESSION_SECRET` (any long random string works locally — see
`.env.example`; production must use a real random value, e.g. `openssl rand -hex 32`) to sign
session cookies, and reads `WEB_ORIGIN` (defaults to `http://localhost:5173`) to know which
origin may send credentialed requests. `apps/web` reads its own `VITE_API_URL` (defaults to
`http://127.0.0.1:3000/api/v1`) if you need to point it somewhere other than the local API.

To use the Gemini Vision provider, fill in a real `GEMINI_API_KEY` in `.env` (never commit it —
`.env` is gitignored). No secrets are committed anywhere in this repository; the test suite mocks
every Gemini call and every crawl (no real network access in `npm test`).

### Authentication

Registration (email + password, min. 8 characters), login, logout and "get current user" are
implemented with `passport` + `passport-local` + `express-session` + `connect-pg-simple` +
`bcryptjs` — a session cookie (`httpOnly`, `sameSite: 'lax'`, `secure` in production), never a
token in localStorage. Registering automatically creates a first workspace with you as its
`'owner'`. See `docs/architecture.md`'s "Authentication and workspace isolation" section for the
full design, including why every route resolves a resource's `workspace_id` from the database
before checking access, rather than trusting the `workspaceId` a request happens to send.

The optional `API_DEV_KEY` (`x-api-key` header) remains available for local/technical testing —
scripts, curl, CI — and deliberately does **not** go through workspace-membership checks; it is
never accepted as normal Web App authentication.

### Trying the API by hand

```sh
curl -X POST http://127.0.0.1:3000/api/v1/workspaces -H 'content-type: application/json' -d '{"name":"Acme Recruiting"}'
# -> {"id": "...", "name": "Acme Recruiting", ...}

curl -X POST http://127.0.0.1:3000/api/v1/projects -H 'content-type: application/json' \
  -d '{"workspaceId":"<id from above>","name":"Vacancy scan","domain":"vacancies"}'
# -> {"id": "...", "domain": "vacancies", "status": "active", ...}

curl -X POST http://127.0.0.1:3000/api/v1/projects/<project id>/runs -H 'content-type: application/json' \
  -d '{"sourceUrl":"https://example.com"}'
# -> crawls the site, extracts+scores+dedupes vacancies, persists them, returns the run summary

curl http://127.0.0.1:3000/api/v1/projects/<project id>/records
# -> the discovered, generic records — domain-specific facts live in each record's own domain_data
```

Without `API_DEV_KEY` set, the routes above need a real logged-in session instead (register/login
first and reuse the client's cookie jar — this is what `packages/discovery-client` and `apps/web`
do; see `apps/api/tests/auth.test.mjs` for the exact request sequence). If `API_DEV_KEY` is set in
`.env`, every request above may instead send an `x-api-key: <that value>` header (see
`apps/api/src/workspace-access.ts`) — a single shared development key for local/technical use
only, never real authentication.

## Online test environment

Fase 2.3 adds a production Docker image (single Node/Express process serving both the API and
the built Web App on one origin — see the root `Dockerfile`) and a manually-triggered GitHub
Actions workflow (`.github/workflows/deploy.yml`) that provisions a Cloud SQL database and
deploys it to Cloud Run. See `docs/deployment.md` for the one-time GCP setup, resource names,
secret rotation, log inspection and teardown — a normal `git push` to `main` never deploys
anything by itself.

## What's next

Billing, team invitations beyond adding a `workspace_members` row directly, white-labeling, an
admin portal, a marketing site, and the `companies`/`housing`/`candidates` domain modules — see
`docs/architecture.md` for what stays deliberately out of scope until then.
