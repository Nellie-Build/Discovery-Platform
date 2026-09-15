# domains/vacancies

The first reference Discovery domain module (job vacancies) — a real, working package
(`@discovery-platform/domain-vacancies`) that exercises every seam `@discovery-platform/core`
exposes: crawling/link-priority, contact extraction, scoring, deduplication, and Gemini Vision.
See `examples/vacancy-discovery` for it wired into a real crawl.

## What works today

`crawlWebsite(url, { extract: extractVacancy, linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers, contactNormalizers })`
recognizes, per crawled page:

```ts
interface VacancyFacts {
  title: string | null;
  company: string | null;
  location: string | null;
  salary: string | null;
  hours: string | null;
  contractType: string | null;
  description: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  sourceUrl: string;
}
```

- **Structured data** (`extractJobPostingJsonLd`, `src/extract-vacancy.ts`) — schema.org
  `JobPosting` JSON-LD: `title`, `hiringOrganization.name` → `company`,
  `jobLocation.address.addressLocality`/`addressRegion` → `location`, `baseSalary` →
  `salary` (as a plain descriptive string, currency+amount+unit — never parsed into a number),
  `employmentType` → `contractType`, `description` (HTML-stripped).
- **Plain-text label extraction** (`extractVacancyText`) — `"Location: Amsterdam"`,
  `"Salary: €2,800 - €3,400 per month"`, `"Hours: 32-40h"`, `"Contract type: permanent"`,
  `"Contact: ..."` — every pattern requires an explicit label immediately before the value,
  never a bare number/word from unrelated text.
- **`<title>`/`<h1>`** as the title fallback when there is no JSON-LD.
- **Contact details** — `phone`/`email` come directly from `@discovery-platform/core`'s own
  `extractContacts()`, reused as-is (see `tests/extract-vacancy.test.mjs`'s test C) — no
  separate contact-parsing code in this package at all.
- **Vacancy-specific link priority** (`VACANCY_LINK_TIER`, `src/config.ts`) — `/vacancies/`,
  `/vacancy/`, `/jobs/`, `/careers/` pages are visited ahead of generic marketing pages.
  `@discovery-platform/core`'s own `linkPriority`, with no config, has no notion of any of these
  words at all (see `tests/crawl-vacancies.test.mjs`).
- **Completeness scoring** (`vacancyCompletenessScore`, `src/scoring/completeness.ts`) — built on
  `@discovery-platform/core`'s generic `runScoring()`, using only objective page-completeness
  signals (title/company/location/description/salary/direct-contact/source-URL presence). This
  is deliberately not a commercial ranking and never ranks the person behind a vacancy.
- **Deduplication** (`findVacancyDuplicates`, `src/dedupe/matching.ts`) — built on
  `@discovery-platform/core`'s generic `findDuplicateCandidates()`, using source-URL and
  company+title(+location) signals. Deliberately never keys on title or location alone, so two
  unrelated vacancies in the same city are never wrongly flagged as duplicates.
- **Vision** (`vacancyVisionConfig`/`createVacancyVisionProvider`, `src/vision/*`) — built on
  `@discovery-platform/core`'s generic `createGeminiVisionProvider()`/`analyzeImage()`, reading a
  vacancy poster/flyer image for title, company, location, salary, hours, contract type, contact
  details and an application URL. Never infers a seniority level, an education requirement, or a
  salary figure from a vague phrase like "competitive salary" — only explicit, visible facts.

A page with only a generic `<title>` and nothing else vacancy-specific — no JSON-LD, no
recognized label, no contact detail — is never reported as a vacancy: title alone is too weak a
signal on its own.

## Did `DomainConfig` need to change?

**No, for any of the five seams above.** `vacanciesDomain` (`src/index.ts`) is a real
implementation of `@discovery-platform/core`'s `DomainConfig<TFacts>`. `extractVacancyText`
(label-based text extraction) and `normalizeVacancyFacts` (whitespace cleanup) fit
`DomainConfig`'s existing `extractText?: (text: string) => Partial<TFacts>` /
`normalize?: (facts) => Partial<TFacts>` shapes exactly as they already were — no new field, no
signature change. Scoring, dedupe and Vision don't touch `DomainConfig` at all: this module just
imports and calls `runScoring`/`findDuplicateCandidates`/`createGeminiVisionProvider` directly,
supplying its own rules/signals/prompt — exactly the same pattern a future domain module would
follow.

One real finding *did* come out of this: **structured-data extraction (JSON-LD) needs the
page's own DOM, not just its plain text**, so it can never be expressed through
`DomainConfig.extractText` alone — it has to live in the crawler-level `extract: (page:
CrawlPage) => ...` callback (part of `CrawlOptions`, not `DomainConfig`).
`DomainConfig.extractText`/`normalize` are for the plain-text sub-step only, never the whole
per-page extraction.

## What is deliberately still not built

CV/candidate parsing (a `candidates` domain), a vacancy database/CMS, claims/invitations for
vacancies, and multi-tenancy — see `docs/architecture.md` for the reasoning, and its section on
why person-matching needs stricter dedupe/Vision rules than a listing does. This module exists
to prove the core engines work for a domain unrelated to accommodation listings — not to ship a
recruitment product.
