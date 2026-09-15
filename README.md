# Discovery Platform

Discovery Platform is an extensible discovery and lead intelligence engine that can gather
information from websites, text and images, then structure, enrich, score and deduplicate it.

**This is a technical foundation, not a finished product yet.** A web app and an API server are
not built in this repository yet — see "What's next" below.

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

## Available domain modules

- **Vacancies** (`domains/vacancies`) — the first, fully working reference implementation.
  Extracts job postings (structured data + plain text), scores page completeness, detects
  duplicate listings, and reads vacancy posters/flyers via Vision.

**Planned, not yet built:** Companies, Housing, Candidates.

## Repository layout

```
Discovery-Platform/
├── packages/
│   └── discovery-core/       The domain-neutral engine (crawler, contacts, scoring, dedupe, Vision)
├── domains/
│   └── vacancies/            The first reference domain module
├── examples/
│   ├── basic-discovery/      Minimal generic crawler usage, no domain module at all
│   └── vacancy-discovery/    The vacancies domain module wired into a real crawl
├── docs/
│   └── architecture.md       The Source → Core → Domain Module → Record → Workflow principle
├── .env.example               GEMINI_API_KEY / GEMINI_VISION_MODEL — copy to .env, never commit .env
└── package.json                Root npm workspace
```

## Getting started

Requires Node.js 24+.

```sh
npm install          # installs every workspace package at once
npm run build        # builds discovery-core, then domains/vacancies
npm run typecheck     # tsc --noEmit across every TypeScript package
npm test              # builds + tests discovery-core, domains/vacancies, then both examples
```

Individual workspace commands also work directly, e.g. `npm run test -w packages/discovery-core`
or `npm run crawl -- https://example.com` from inside `examples/basic-discovery`.

To use the Gemini Vision provider, copy `.env.example` to `.env` and fill in a real
`GEMINI_API_KEY` (never commit it — `.env` is gitignored). No secrets are committed anywhere in
this repository; the test suite mocks every Gemini call.

## What's next

Before a web app or API server is worth building on top of this: a real HTTP API layer, a
database/persistence layer, and the product decisions that go with them (which are explicitly
out of scope for this phase — see `docs/architecture.md`). This repository's job is to be a
correct, well-tested, dependency-clean foundation those can be built on later.
