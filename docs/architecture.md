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
Workflow / application     (whatever the domain hands the finished record to next — not part of
                            this repository yet; see "What this repository does not do yet")
```

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

No web app, no API server, no database, no login, no multi-tenancy, no billing, and no
`companies`/`housing`/`candidates` domain modules exist yet. This repository is, deliberately,
just the engine and its first reference domain — see the root `README.md` for what is proven to
work today and what is expected to come next.
