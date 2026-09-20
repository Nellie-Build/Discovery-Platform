# Vacancy candidate URL discovery

Website Discovery queues every in-scope link and sitemap URL as a *candidate*, ranks it with
`rankVacancyCandidate` (`domains/vacancies/src/config.ts`) and visits the best ones first. This note
records why some sites' detail pages were not reached and what was changed. HTTP fetching and Cheerio
were sufficient for all of them: nothing here needs a browser.

## Causes found (measured with the built crawler on 4 public sites, 2 pages, extraction off)

| Case | Cause | Class |
|---|---|---|
| Detail URLs like `/o/<slug>` (applicant-tracking sites) | ranked as `general` (score 10), 1 of 22 recognised | B: discovered, ranking too low |
| Detail URLs like `/nl/what:job/jobID:123/` | ranked as `general`, 0 of 21 recognised | B |
| Big site whose sitemap index lists the vacancy sitemap as the 7th of 8 children | the shared metadata budget (8 requests, robots.txt included) was spent on blog/event/page sitemaps; the vacancy sitemap was never fetched (`Verzoeklimiet bereikt`) | E: budget/order |
| Site whose `/sitemap.xml` redirects to the index that robots.txt also names | the index was fetched twice, using a budget slot | E |
| Site with few links on the start page but a full job sitemap | already worked: the sitemap yielded 404 detail candidates; an earlier run's failed child-sitemap fetches were transient network errors | none |

## Changes

* `rankVacancyCandidate` — structural signals only, no hostnames:
  * `job_identifier`: a `jobId` / `job_id` / `vacancyId` / `positionId` / `postingId` … query parameter, or a
    `jobID:123` path segment; the key must be the whole key/prefix and the value must be an identifier
    (at least one digit). `+45` (`+15` when the path already says detail); classification `detail`.
  * `record_id_route`: `/position/12345`, `/openings/ab-4471`: a posting word (`position`, `opening`,
    `posting`, `opportunity`, `requisition`) followed by an id with at least three digits. `+40`.
  * `short_detail_route`: a one-letter route followed by a descriptive slug (`/o/senior-software-engineer`):
    at least 8 characters and three words (two words when the source is a sitemap or a listing), not a
    generic route word. `+35`. `/o/`, `/o/team`, `/o/senior` and `/x/y` stay `general`.
  * Search/filter URLs (`q`, `query`, `search`, `filter*`) never get the record-route or short-route
    promotion, and the existing penalties are unchanged. Listing, search and generic routes rank as before.
  * The existing `sitemap_detail` / `listing_detail_link` bonuses apply to the new detail classes; a sitemap
    never raises a URL that is not detail-like.
* `createCrawlSession` sitemap discovery (`discovery-core`): child sitemaps of an index whose address matches
  a category the caller declared relevant (`linkPriorityExtraTiers`) are fetched first, and a sitemap that
  redirected is not fetched again under its destination address. The budget, the limit of 10 children and
  the order without such a signal are unchanged.

## Not changed

Company/description extraction, the overview classifier, relevance, the candidate queue, concurrency,
budgets and both crawl engines. Known and left alone: `/vacatures/alle-vacatures` and
`/vacatures/open-sollicitatie` are still classified as detail by the classic `/vacatures/<x>` rule.

## One vacancy under many addresses (stable job identity)

Live finding: a site publishing every job under a language segment (`/en/…/jobID:966837/`, `/de/…`, 12 variants
per job) filled a 25-record target with 8 distinct vacancies. Nothing recognised the variants as one vacancy:
record dedupe needs the same `sourceUrl` or company + title, and the company was null.

* `domains/vacancies/src/job-identity.ts` — `extractVacancyUrlIdentity(url)`: the one implementation of an
  explicit job identifier (`jobId` / `job_id` / `vacancyId` / `positionId` / `postingId` … query parameter or
  `jobID:123` path segment, value with at least one digit). The identity is `origin|type|value`
  (origin without a leading `www.`), so the same id on another site is never the same vacancy. No language,
  slug, title, page number or tracking parameter ever forms an identity; the URL itself is never rewritten.
  Ranking (`job_identifier`), candidate dedupe and record dedupe all use it.
* Candidate level: `CandidateRank.dedupeKey` (optional, supplied by the domain; core never interprets it).
  `CandidateQueue` keeps at most one waiting URL per key (better score wins, the earlier one on a tie) and
  keeps the key claimed after `take()`, so a variant discovered while the first is in flight (Crawlee
  concurrency) or after it finished is never queued. The requested URL still goes first.
* Record level: new exact dedupe signal `stableJobIdentity` in `findVacancyDuplicates` (same origin + same
  identifier is a duplicate even with company = null and a different `sourceUrl`), so a record stored
  earlier via another variant is recognised in later runs (`onlyNewRecords`). Existing signals are unchanged.
* Target counting already runs on the deduplicated records, so variants no longer fill `targetRecords`.
* Diagnostics: `uniqueUrlsDiscovered` (unique canonical URLs) stays; `uniqueCrawlIdentities` and
  `candidateIdentityDuplicates` (= URLs that are only another address of a known identity) are new.
  Discovery still lists every published URL.
* Open applications: `open_application` (−50, classification `general`) for clear wording in the URL or link text
  (`open-sollicitatie`, `open-application`, `spontaneous`, `spontane sollicitatie`, `initiatiefsollicitatie`).
  A lower crawl priority only: they are still visited with budget left and the extractor decides. Stages,
  trainee, internship and volunteer wording is not touched.
* Known limit: two different vacancies on one site that share the same identifier value under different
  identifier *spaces* (e.g. `what:job/jobID:4041` and `what:spontaneous/jobID:4041`) would count as one.
