# Local-first development and testing

Everything needed to develop and test runs on your own machine; no cloud account is involved at any point.
The GCP deployment (`.github/workflows/deploy.yml`, `docs/deployment.md`) is unchanged and stays a separate, optional way to run
the same code.

## What is (and is not) cloud-dependent

| Area | Local | Online test environment |
|---|---|---|
| Application code (API, web, crawler, extractors) | no cloud dependency | same code |
| Database | any PostgreSQL via `DATABASE_URL` or `POSTGRES_*` | Cloud SQL, reached through the Cloud Run socket in `DATABASE_URL` |
| Secrets (`SESSION_SECRET`, API keys) | `.env` / compose environment | Secret Manager, injected as env vars |
| Image build and run | `docker compose` or plain Node | Artifact Registry + Cloud Run service `discovery-platform-web` |
| Migrations | `npm run db:migrate` or the compose `migrate` service | Cloud Run job `discovery-platform-migrate` |
| CI (`ci.yml`) | `npm test` | GitHub Actions |
| Crawl egress | your own connection | Cloud Run egress |

`GEMINI_API_KEY`, `BRAVE_SEARCH_API_KEY` are optional; without them poster analysis and web search are simply unavailable.

## Option A — Docker Compose (whole product)

```sh
cp .env.example .env            # optional; every value below has a local default
docker compose --profile app up --build       # PostgreSQL + migrations + API + Web App
# then open http://localhost:8080
docker compose --profile app down             # stop (keeps the database volume)
docker compose --profile app down -v          # stop and delete the local database
```

`docker compose up -d` (no profile) starts PostgreSQL only, as before. Useful variables (all optional): `APP_PORT`
(default 8080), `POSTGRES_PORT`, `POSTGRES_USER/PASSWORD/DB`, `DISCOVERY_CRAWLER_ENGINE` (`crawlee` default, `legacy` rollback),
`VITE_ENV_LABEL` (badge text, default "Lokaal"). The compose app runs with `NODE_ENV=development` because production mode
sets Secure cookies, which browsers do not keep over plain `http://localhost`.

> **Status of Option A:** `docker-compose.yml` has been checked statically only (the YAML parses, the `app` profile and
> the `depends_on` chain are consistent). It has **not** been run: the machine it was written on has neither Docker nor WSL.
> The same stack was tested without Docker (Option B: local PostgreSQL, migrations, API + Web App, and a local WBO and SPIE
> run with the Crawlee engine, 10 records each). Run `docker compose --profile app up --build` once on a machine with Docker
> before relying on it.

## Option B — plain Node + local PostgreSQL (fast inner loop)

```sh
npm ci
docker compose up -d           # or on Windows without Docker: npm run db:local:up (embedded PostgreSQL)
npm run db:migrate
npm run dev                    # API on :3000 and Vite on :5173 (WEB_ORIGIN default matches)
```

`npm run db:local:up` keeps its data in `data/.postgres`; set `LOCAL_POSTGRES_DIR` to use another folder (initdb needs a
POSIX-style filesystem such as NTFS, not exFAT).

## Verify

```sh
npm test && npm run build && npm run typecheck
```

A local end-to-end check: register through the web app (or `POST /api/v1/auth/register`), create a project with domain
`vacancies`, start a website run against `https://www.werkenbijdeoverheid.nl/` or `https://www.werkenbijspie.nl/vacatures`
with a small `targetRecords` (10), and read the records back.
