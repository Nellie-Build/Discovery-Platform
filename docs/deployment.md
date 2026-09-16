# Deployment (fase 2.3 — first online test environment)

This is a **test environment**, not a production launch — see the Web App's small "Testomgeving"
badge (only present when `VITE_ENV_LABEL` is set at build time, which the Dockerfile does).

## Architecture

One Docker image (see the root `Dockerfile`) runs one Node/Express process that serves both the
API and the built Web App on the same origin:

```
https://<cloud-run-url>/           → the built React Web App (static files + SPA fallback)
https://<cloud-run-url>/api/v1/*   → the Express API
```

Single origin means the session cookie is always first-party — no cross-origin cookie
complexity for this first deployment (see `apps/api/src/server.ts`'s `webDistDir` option and
`docs/architecture.md`'s "Authentication and workspace isolation" section for how the cookie
itself is configured).

Three Cloud Run resources, all named `discovery-platform-*` so they're unmistakably this
product's own, never Maroc2Stay's:

- **`discovery-platform-web`** — the Cloud Run *service* running the image above, publicly
  reachable, `--allow-unauthenticated` (auth happens at the application layer via login, not at
  the Cloud Run layer).
- **`discovery-platform-migrate`** — a Cloud Run *Job* running the *same* image with its command
  overridden to `node packages/discovery-db/dist/migrate.js` — schema migrations are a deliberate,
  separate step (see fase 2.3's brief), never something that runs automatically on every web
  container start. `packages/discovery-db`'s migration runner is idempotent either way (see
  `packages/discovery-db/tests/migrate.test.mjs`'s "a second run against an already-migrated
  database applies nothing").
- **`discovery-platform-db`** — a Cloud SQL for PostgreSQL instance, its own `discovery_platform`
  database, its own `discovery_app` user — nothing shared with Maroc2Stay. Cloud Run's built-in
  Cloud SQL connector mounts it as a Unix socket; `DATABASE_URL` points at that socket path (see
  `.github/workflows/deploy.yml`'s "Create the DB user" step for the exact connection-string
  shape), so `packages/discovery-db`'s existing `DATABASE_URL`-or-`POSTGRES_*` connection logic
  needed no code change at all.

## One-time setup (you do this — the deploy workflow has no permission to)

### 1. Create the GCP project and enable billing

```sh
gcloud projects create discovery-platform-508814 --name="Discovery-Platform"
gcloud billing projects link discovery-platform-508814 --billing-account=<YOUR_BILLING_ACCOUNT_ID>
```

If you're reusing the same GCP account/billing as Maroc2Stay (the brief explicitly allows this
for the first test), this is still a **separate project** — GCP resources are scoped per project,
so nothing here can accidentally touch a Maroc2Stay Cloud Run service or database.

### 2. Create the deploy service account — no key, ever

There is **no service-account JSON key anywhere in this setup**, and none needs to be created —
this project's org policy (`iam.disableServiceAccountKeyCreation`) blocks that outright, and
even without that policy it's the wrong tool here. GitHub Actions authenticates to GCP with
**Workload Identity Federation**: keyless OIDC. GitHub mints a short-lived, signed identity token
for the workflow run; Google exchanges it for short-lived GCP credentials that impersonate
`discovery-platform-deployer`, without any long-lived secret ever existing on either side.

First, the service account itself — same identity as before, just never gets a key:

```sh
PROJECT_ID=discovery-platform-508814

gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  --project="$PROJECT_ID"

gcloud iam service-accounts create discovery-platform-deployer \
  --project="$PROJECT_ID" --display-name="Discovery Platform GitHub Actions deployer"

DEPLOYER="discovery-platform-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

for ROLE in roles/run.admin roles/cloudsql.admin roles/artifactregistry.admin \
            roles/secretmanager.admin roles/iam.serviceAccountAdmin \
            roles/iam.serviceAccountUser roles/resourcemanager.projectIamAdmin \
            roles/serviceusage.serviceUsageAdmin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${DEPLOYER}" --role="$ROLE"
done
```

(These are the same roles as before — Workload Identity Federation only changes *how* GitHub
Actions authenticates as this account, never *what* it's allowed to do once authenticated.)

### 3. Create the Workload Identity Pool and provider, restricted to this one repository

```sh
PROJECT_ID=discovery-platform-508814
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

gcloud iam workload-identity-pools create github-actions \
  --project="$PROJECT_ID" --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --project="$PROJECT_ID" --location=global \
  --workload-identity-pool=github-actions \
  --display-name="GitHub" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository == 'Nellie-Build/Discovery-Platform'"
```

The attribute mapping exposes the GitHub OIDC token's `repository` claim to Google as
`attribute.repository`; the attribute condition is the actual gate — a token whose `repository`
claim isn't exactly `Nellie-Build/Discovery-Platform` is rejected before it ever reaches the
"which service account may this impersonate" check below. Forks, other repositories, and any
other GitHub organization are refused at this layer, independently of the IAM binding.

Then grant that pool — scoped to this repository's attribute, not the whole pool — permission to
impersonate the deployer service account:

```sh
gcloud iam service-accounts add-iam-policy-binding \
  "discovery-platform-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions/attribute.repository/Nellie-Build/Discovery-Platform"
```

Finally, get the provider's full resource name — this is the exact value that goes into the
GitHub repository variable below:

```sh
gcloud iam workload-identity-pools providers describe github \
  --project="$PROJECT_ID" --location=global --workload-identity-pool=github-actions \
  --format='value(name)'
# -> projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-actions/providers/github
```

(`PROJECT_NUMBER` is not the project *ID* — find it via the command above, or in the Cloud
Console under this project's Dashboard/IAM & Admin → Settings, next to "Project number".)

### 4. Add the GitHub repository variable and secrets

Repository → Settings → Secrets and variables → Actions:

| Kind | Name | Required | Value |
|---|---|---|---|
| **Variable** | `GCP_WORKLOAD_IDENTITY_PROVIDER` | yes | The full provider resource name from step 3 above |
| Secret | `GEMINI_API_KEY` | no | A real Gemini API key, if you want it stored in Secret Manager for later use |
| Secret | `GEMINI_VISION_MODEL` | no | Only if you want to pin a non-default Gemini model |

`GCP_WORKLOAD_IDENTITY_PROVIDER` is a **repository variable**, not a secret — it's a resource
name, not a credential, and `google-github-actions/auth@v2` reads it via
`vars.GCP_WORKLOAD_IDENTITY_PROVIDER` in `deploy.yml`. There is no `GCP_SA_KEY` secret in this
setup at all; nothing in this repository ever holds a service-account key.

`GEMINI_API_KEY` is optional here specifically because the current Discovery run (crawl → extract
→ score → dedupe) never calls Gemini Vision at all — `apps/api`'s vacancies adapter doesn't wire
it in yet (Vision is only used for reading vacancy poster *images*, a capability the domain module
exports but the API doesn't call). It's still stored in Secret Manager, per the brief, so it's
ready the moment that changes.

### 5. Run the workflow

Actions tab → "Deploy (online test environment)" → Run workflow. Defaults to project id
`discovery-platform-508814`, region `europe-west1` — override either as workflow inputs if you used
different values above.

The workflow provisions every GCP resource idempotently (safe to re-run), builds and pushes the
image, runs the migration job and waits for it, deploys the web service, and finishes with an
automated smoke test (register → logout → login → create a Vacatures project → start a Discovery
run against `https://example.com` → check the result isn't `failed` → confirm the records
endpoint responds). The job summary prints the resulting service URL.

**Why `https://example.com` for the automated smoke test, not a real vacancy page:** the workflow
needs a URL that is stable, always reachable, and won't rate-limit or block an unfamiliar crawler
bot — a real company's careers page is neither guaranteed to be stable nor ours to hit
automatically on every deploy. `example.com` has no vacancies, so the automated check only proves
the pipeline runs end-to-end and persists a run record (0 records found is the correct, expected
outcome for that URL) — it does **not** prove a real vacancy is found and rendered correctly.
Do that part manually once, per the Definition of Done, with a real public vacancy page you
choose (see the fase 2.3 report for the specific page used and what it found).

## Rotating the Gemini key later

```sh
# from a shell with gcloud auth'd, or just re-run the deploy workflow after updating the
# GEMINI_API_KEY GitHub secret — it always pushes a new secret version on every run.
printf '%s' "$NEW_KEY" | gcloud secrets versions add discovery-platform-gemini-api-key --project=discovery-platform-508814 --data-file=-
gcloud run services update discovery-platform-web --region=europe-west1 --project=discovery-platform-508814 \
  --update-secrets=GEMINI_API_KEY=discovery-platform-gemini-api-key:latest
```

`SESSION_SECRET` and the database password are deliberately generated **once**, on the first
deploy, and never rotated automatically (see `deploy.yml`'s own comments) — rotating
`SESSION_SECRET` would instantly log out every active session, and rotating the DB password needs
the Cloud SQL user updated in lockstep. Rotate either by hand if you ever need to:

```sh
NEW_SECRET="$(openssl rand -hex 32)"
printf '%s' "$NEW_SECRET" | gcloud secrets versions add discovery-platform-session-secret --project=discovery-platform-508814 --data-file=-
gcloud run services update discovery-platform-web --region=europe-west1 --project=discovery-platform-508814 \
  --update-secrets=SESSION_SECRET=discovery-platform-session-secret:latest
```

## Checking logs

```sh
gcloud run services logs read discovery-platform-web --region=europe-west1 --project=discovery-platform-508814 --limit=100
```

Every line is one structured JSON object (see `apps/api/src/logging.ts`) — request id, method,
route, status, duration, and (when relevant) `projectId`/`runId`/`userId`. It never logs a
password, session cookie, API key, or full auth header, by construction: the logger only ever
reads `req.method`/`req.path`/`res.statusCode`/timing/the few explicit ids a route sets on
`res.locals` — there is no code path in it that could log a header or body even if a future
change tried to.

## Tearing it down

```sh
gcloud run services delete discovery-platform-web --region=europe-west1 --project=discovery-platform-508814 --quiet
gcloud run jobs delete discovery-platform-migrate --region=europe-west1 --project=discovery-platform-508814 --quiet
gcloud sql instances delete discovery-platform-db --project=discovery-platform-508814 --quiet
gcloud artifacts repositories delete discovery-platform --location=europe-west1 --project=discovery-platform-508814 --quiet
# Or, to remove everything at once and stop billing entirely:
gcloud projects delete discovery-platform-508814
```

## What's deliberately not here yet

A custom domain (the Cloud Run-issued `*.run.app` URL is enough for a first test — see the
brief's "custom domain niet noodzakelijk maken"), autoscaling tuning beyond `--max-instances=2`,
a CDN, structured log export/alerting, and a staging/production split. All of that is a decision
for once this first test environment has actually been used and reviewed, per the brief.
