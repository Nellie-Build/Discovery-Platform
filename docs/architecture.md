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
workspaces          (id, name, ...)
  └─ projects        (id, workspace_id, name, domain, status, config JSONB, ...)
       └─ discovery_runs   (id, project_id, status, stats JSONB, error, ...)
       └─ discovery_records (id, project_id, domain, display_name, domain_data JSONB,
                              classification JSONB, score, ...)
            └─ record_sources  (id, record_id, source_type, source_url, source_data JSONB, ...)
            └─ record_contacts (id, record_id, type, value, normalized_value, confirmed, ...)
```

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

## Preparing for multiple tenants, without building one yet

Every `project` belongs to exactly one `workspace` from the very first migration — not because
multi-tenancy is built (it isn't: no auth, no billing, no teams/roles, no invitations, no
white-labeling exist), but so that building it later is a product decision, not a migration
touching every existing row. The API's dev-key middleware (`apps/api/src/auth.ts`) is
deliberately the *only* place a real auth scheme would need to plug in later: it already sits
centrally, in front of every route, doing nothing but a header check today.

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

## What this repository does not do yet

No web app/UI, no real user authentication (only an optional shared development API key), no
multi-tenancy, no billing, and no `companies`/`housing`/`candidates` domain modules exist yet.
This repository is, deliberately, the engine, its persistence layer, its HTTP API, and one
reference domain — see the root `README.md` for what is proven to work today and what is
expected to come next.
