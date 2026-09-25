# Architecture

Discovery Platform separates a domain-neutral **engine** from the **domain modules** built on
top of it. This document describes that separation and the rule that keeps it real.

## The principle

```
Source                    (a website, a manual/social submission, an uploaded image, ...)
  ↓
Discovery Core            (crawl / fetch, generic contact extraction, generic scoring engine,
                            generic deduplication engine, generic Gemini Vision call — no
                            opinion on what any of it "means")
  ↓
Domain Module              (turns raw facts into the domain's own record shape, with its own
                            scoring rules, dedupe signals and Vision schema/prompt)
  ↓
Structured Record          (the domain's own typed data, with source/provenance kept alongside it)
  ↓
Workflow / application     (apps/api persists the record and serves it over HTTP today; a web
                            app/UI is the next consumer in this chain — see "What this
                            repository does not do yet")
```

`apps/api` is itself a thin composition layer, not a fifth architectural box: it never parses a
domain-specific field (see "The domain registry" below) and never adds business logic of its
own — it only wires a domain module's `runDiscovery()` output into `packages/discovery-db`'s
generic tables.

`packages/discovery-core` is where the arrows above cross from generic to specific — everything
left of it has no business logic; everything right of it is a domain module's own decision.

## The hard rule

**`packages/discovery-core` must never know about an individual domain.** Concretely:

- No field name, prompt string, point value, or threshold that belongs to one domain (a hotel,
  a job title, a salary figure) may appear anywhere in `packages/discovery-core/src/`.
- Domain modules (`domains/*`) may depend on `packages/discovery-core`; the core may never
  depend on a domain module, in either direction.
- Every one of the core's four engines — crawler (`src/crawler/`), contact extraction
  (`src/extract/contacts.ts`), scoring (`src/scoring/engine.ts`), deduplication
  (`src/dedupe/engine.ts`), and Vision (`src/vision/provider.ts`) — takes the domain's own rules
  as a parameter (a rule list, a signal list, a prompt/schema/parser) rather than hard-coding
  any of them. `packages/discovery-core/tests/dependency-boundary.test.mjs` checks this
  automatically, by scanning the actual published source for forbidden vocabulary and import
  directions — not by convention someone has to remember.

`domains/vacancies` exists specifically to keep this rule honest: it is a real, working domain
with its own extraction, scoring, deduplication and Vision configuration, built entirely on the
core's public API (never a deep import into the core's internals). A future domain (companies,
housing, candidates) is expected to look structurally identical — its own folder under
`domains/`, its own rules, the same four core engines underneath.

## The persistence schema stays domain-neutral too

`packages/discovery-db` (PostgreSQL) mirrors the same rule as the engine: `Workspace → Project →
Discovery Run → Record → Sources/Contacts`, and no table ever gets a domain-specific column.

```
users               (id, email, password_hash, ...)
workspaces          (id, name, ...)
  └─ workspace_members (workspace_id, user_id, role: 'owner' | 'member')
  └─ projects        (id, workspace_id, name, domain, status, config JSONB, ...)
       └─ discovery_runs   (id, project_id, status, stats JSONB, error, ...)
       └─ discovery_records (id, project_id, domain, display_name, domain_data JSONB,
                              classification JSONB, score, ...)
            └─ record_sources  (id, record_id, source_type, source_url, source_data JSONB, ...)
            └─ record_contacts (id, record_id, type, value, normalized_value, confirmed, ...)
session             (sid, sess JSON, expire) — connect-pg-simple's session store, unrelated to
                     the domain-neutral chain above
```

`users` and `workspace_members` (added in `packages/discovery-db/migrations/002_auth.sql`) are
the one deliberate exception to "no domain-specific column ever" — they are not a domain concept
at all, they are the generic multi-tenancy seam every domain shares. `role` only distinguishes
`'owner'` (created the workspace) from `'member'` (added to it) — there is no broader RBAC yet.

A project declares its `domain` (`"vacancies"` today) once, up front. Every fact specific to
that domain — a salary, a bedroom count, a skill list — lives inside `domain_data` (and
`classification`) as opaque JSONB; the schema itself never interprets it, the same way
`packages/discovery-core` never interprets a `ScoringRule`'s reason string. Adding a `companies`
domain later needs zero migration to these tables — only a new domain module and one new line in
the domain registry (see below).

## The domain registry: how `apps/api` stays domain-neutral

`apps/api/src/domain-registry.ts` is the *only* place the API is allowed to know a domain
module's name (`{ vacancies: vacanciesAdapter }` today). Every route (`apps/api/src/routes/*.ts`)
looks up `registry[project.domain]` and calls its `runDiscovery(sourceUrl, existingRecords)` —
it never imports `@discovery-platform/domain-vacancies`, or any domain module, directly (checked
automatically by `apps/api/tests/dependency-boundary.test.mjs`, the same "scan the actual
source" style as the core's own boundary test). A `DomainAdapter` is responsible for its own
crawl → extract → score → dedupe pipeline, using `@discovery-platform/core`'s engines and its own
domain module's rules; `apps/api` only persists whatever records the adapter returns.

Adding `companies`/`housing`/`candidates` later means: write a new domain module (like
`domains/vacancies`), write a new adapter file next to
`apps/api/src/domains/vacancies-adapter.ts`, and add one line to the registry. No route changes,
no database migration.

## Authentication and workspace isolation

Every `project` belongs to exactly one `workspace`, and every `workspace` a user can see is one
they have a `workspace_members` row for — this is deliberately *not* full RBAC (no invitations,
no billing, no teams beyond "owner"/"member"), but it is real: a logged-in user's session cookie
is the only thing the API trusts to decide which workspaces, projects, runs and records they may
reach.

**Auth stack:** `passport` + `passport-local` (credential verification) + `express-session` +
`connect-pg-simple` (sessions live in the `session` table above, not in memory — surviving an API
restart) + `bcryptjs` (password hashing, pure JS so it needs no native build step). No hand-rolled
cryptography anywhere. The session cookie (`discovery_platform_sid`) is `httpOnly`, `sameSite:
'lax'`, and `secure` once `NODE_ENV=production` — the Web App never sees or stores a token; every
`packages/discovery-client` request sends `credentials: 'include'` and nothing else. `cors()` is
configured with `credentials: true` and locked to exactly `WEB_ORIGIN`, so no other origin can
even attempt a credentialed request.

**`apps/api/src/workspace-access.ts`** is the one place this is enforced, in front of every
resource route:

- `authenticate(apiKey)` sets `req.auth` to either `{ type: 'user', userId }` (from
  `req.user`, once Passport's session middleware has deserialized it) or `{ type: 'dev-key' }`
  (only when `API_DEV_KEY` is set *and* the caller sent a matching `x-api-key` header — local
  scripts/tests only; it is never accepted from the Web App and never bypasses the check below by
  design, it bypasses it by an explicit, documented exception for non-browser tooling).
- `assertWorkspaceAccess(pool, req, workspaceId)` — for a `'user'` request, looks up the
  `workspace_members` row for that user and workspace; if it is missing, the route responds
  **404**, not 403, so a non-member probing another workspace's id cannot even confirm the id
  exists. A `'dev-key'` request skips this check entirely (the trade-off the task explicitly
  asked for: the dev key remains usable for local/technical testing, never for normal Web App
  auth).
- Every route resolves *up* to the owning `workspace_id` before calling this — a project route
  checks its own `workspace_id`; a run route resolves `run → project → workspace_id`; a record
  route resolves `record → project → workspace_id`. **The frontend's own `workspaceId` is never
  trusted by itself** — it only ever selects *which* workspace to query; access is re-derived from
  the database on every request.

Registering (`POST /auth/register`) creates the user, a first personal workspace, and an `'owner'`
`workspace_members` row for it in one transaction, then logs the new user in immediately (a
session is created) — this is the "automatically receive a workspace" flow the Web App's
onboarding relies on.

## Crawler security: a logged-in user supplies an arbitrary URL

Starting a Discovery run means a logged-in user hands the crawler a URL of their own choosing —
once the system is reachable from the public internet (fase 2.3), that is an SSRF vector by
construction, not an edge case. `packages/discovery-core/src/crawler/http.ts`'s `fetchPublicUrl`
is the *only* place this package makes an outbound request, and it refuses to open a socket
unless every DNS-resolved address for the target hostname is a genuine public unicast address
(`isPublicAddress`, built on `ipaddr.js`'s address-range classification) — rejecting loopback
(`127.0.0.1`, `::1`), every RFC1918/unique-local private range, link-local addresses (including
`169.254.169.254`, the cloud metadata endpoint on GCP/AWS/Azure alike), and an IPv4-mapped IPv6
address whose embedded IPv4 is itself private. The exact address that passed the check is then
*pinned* for the actual connection (a custom `lookup` option on the request), closing the
DNS-rebinding window between validating an address and connecting to it. `url-policy.ts`'s
`websiteScope` adds an earlier, cheaper rejection for obviously-invalid hostnames (bare
`localhost`, anything without a dot) — but the address-level check in `http.ts` is the real,
complete defense, since a literal IP like `169.254.169.254` passes the hostname-shape check just
fine and is only ever caught there. See `packages/discovery-core/tests/http.test.mjs` for the
regression tests covering every case above.

## A domain with different rules: candidates

Person-matching needs stricter rules than listing-matching does, and this is worth deciding in
writing before a `candidates` domain is ever built, not discovered mid-implementation:

- A listing domain (`domains/vacancies`, or an accommodation-style domain) can safely merge two
  records on *weak, corroborating* signals — a shared phone number plus a matching name and
  city, say — because merging two distinct *listings* that happen to share an owner's contact
  detail is a low-stakes, reversible mistake.
- Merging two distinct *people* on the same kind of weak evidence is not low-stakes — it can
  silently combine two different candidates' histories, applications, or contact records under
  one identity.
- **Rule for whenever a `candidates` domain is built:** person-level deduplication may only ever
  merge on an explicit, safe identifier the person themselves confirmed belongs to them (a
  verified e-mail address, a verified phone number, a login/account id) — never on
  name-and-region-shaped weak matching, and never on a signal combination whose sole purpose is
  to reach a merge threshold through corroboration.
- The same reasoning extends to image/CV analysis: a `candidates` Vision config would run
  through the exact same generic `VisionProvider.analyzeImage` every other domain uses — the
  core has no opinion on what a candidate is — but the domain itself must never infer an age (or
  use a photo/date of birth) to influence a score or ranking, never infer or use gender,
  ethnicity/origin, health status, religion, or any other protected/sensitive characteristic for
  ranking or filtering, and must only process information that is explicit and professionally
  relevant.

None of this is a technical limitation of the core — `findDuplicateCandidates()` and
`VisionProvider.analyzeImage` are signal/schema-agnostic and would run whatever a `candidates`
domain supplied. The constraint is entirely on what signals and inferences a person-matching
domain is *allowed* to define.

## Module access: global switch, packages and individual choices

Whether a module (a project `domain`) can be used in a workspace is checked server-side in
`apps/api/src/module-registry.ts` when a project is created and when a run is started (never only by hiding
a button). Three things are stored apart, and one view combines them:

- the **global** switch in `modules` (`PATCH /admin/modules/:id`). It always wins: a module that is off globally
  is off in every workspace (`module_disabled`, 403);
- the workspace's **package** in `workspaces.module_package_id` (`PUT /admin/workspaces/:workspaceId/package`).
  Packages and their modules are rows in `module_packages` / `module_package_modules`: Vacancies, Tenders,
  Compleet (both) and Maatwerk (includes nothing by itself). Adding a future module to a package is one row. A new
  workspace gets Compleet;
- **individual choices** in `workspace_modules` (`PUT /admin/workspaces/:workspaceId/modules/:moduleId` with
  `enabled: true | false | null`, `null` = follow the package again).

The `workspace_module_access` view is the one definition of access: on globally AND (the individual choice, or
else whether the package includes the module); otherwise `module_not_enabled_for_workspace` (403). It also
marks a choice that `deviates` from the package, which the Admin > Workspaces tab shows as "Adjusted". Picking a
regular package starts clean from it (individual choices removed); picking Maatwerk keeps the current modules as
individual choices. Migration 009 gave every existing workspace the package matching its choices, kept those
choices, and aborts if any workspace's effective access would change. Changing access never touches existing
projects, runs or records; they stay readable. The new-project form reads `GET /workspaces/:id/modules` only so
it does not offer a module the API would refuse. Packages are a technical grouping only: no prices,
subscriptions or billing.

## Deployment topology

See `docs/deployment.md` for the full picture — in short, one Docker image (root `Dockerfile`)
runs a single Node/Express process that serves the API and the built Web App on one origin, a
separate Cloud Run Job runs schema migrations (never automatically on every web container start),
and a Cloud SQL for PostgreSQL instance is this product's own, never shared with Maroc2Stay.

## What this repository does not do yet

No billing, no team invitations beyond adding a `workspace_members` row directly, no
white-labeling, no admin portal, no marketing site, and no `companies`/`housing`/`candidates`
domain modules exist yet. `apps/web` covers registration/login/logout, workspaces, projects,
starting and following a Discovery run, and browsing/inspecting records — see the root
`README.md` for what is proven to work today and what is
expected to come next.
