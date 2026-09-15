# Discovery Platform

Discovery Platform is an extensible discovery and lead intelligence engine that can gather
information from websites, text and images, then structure, enrich, score and deduplicate it,
persist it in PostgreSQL, and serve it over an HTTP API.

**This is a technical foundation, not a finished product yet.** There is no web app/UI yet — see
"What's next" below.

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
│   └── discovery-db/         PostgreSQL persistence — Workspace → Project → Run → Record → Sources/Contacts
├── domains/
│   └── vacancies/            The first reference domain module
├── apps/
│   └── api/                  The HTTP API (/api/v1) — composes core + a domain registry + discovery-db
├── examples/
│   ├── basic-discovery/      Minimal generic crawler usage, no domain module at all
│   └── vacancy-discovery/    The vacancies domain module wired into a real crawl
├── docs/
│   └── architecture.md       The Source → Core → Domain Module → Record → Workflow principle
├── scripts/
│   └── local-postgres.mjs    Windows-friendly embedded Postgres launcher (no Docker needed)
├── docker-compose.yml         PostgreSQL for local development (any platform)
├── .env.example               Copy to .env — GEMINI_*, POSTGRES_*, API_* — never commit .env
└── package.json                Root npm workspace
```

## Getting started

Requires Node.js 24+ and a PostgreSQL server (see "Local development" below).

```sh
npm install
docker compose up -d      # starts PostgreSQL (or: npm run db:local:up on Windows without Docker)
npm run db:migrate        # applies packages/discovery-db/migrations
npm run build              # builds discovery-core, discovery-db, domains/vacancies, apps/api
npm run typecheck           # tsc --noEmit across every TypeScript package
npm test                    # tests every package (uses an embedded PGlite database — no live server needed)
npm run dev:api              # starts the API on http://127.0.0.1:3000/api/v1
```

Individual workspace commands also work directly, e.g. `npm run test -w packages/discovery-core`
or `npm run crawl -- https://example.com` from inside `examples/basic-discovery`.

### Local development

Copy `.env.example` to `.env` first. Two ways to get a local PostgreSQL server:

- **Docker (any platform):** `docker compose up -d` starts a `postgres:16-alpine` container
  using the `POSTGRES_*` values from `.env`.
- **Windows without Docker:** `npm run db:local:up` starts an embedded, portable PostgreSQL
  binary under `data/.postgres/` (gitignored) — no system install, no admin rights. `npm run
  db:local:down` stops it, `npm run db:local:status` checks it.

Either way, `npm run db:migrate` then applies every migration in `packages/discovery-db/migrations`.

To use the Gemini Vision provider, fill in a real `GEMINI_API_KEY` in `.env` (never commit it —
`.env` is gitignored). No secrets are committed anywhere in this repository; the test suite mocks
every Gemini call and every crawl (no real network access in `npm test`).

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

If `API_DEV_KEY` is set in `.env`, every request above also needs an `x-api-key: <that value>`
header (see `apps/api/src/auth.ts`) — this is a single shared development key, not real
authentication; see `docs/architecture.md`'s multi-tenancy note for what a real auth layer would
add later without a schema change.

## What's next

A web app/UI — see `docs/architecture.md` for what stays out of scope until then (real
authentication, billing, teams/roles, white-labeling, and the `companies`/`housing`/`candidates`
domain modules).
