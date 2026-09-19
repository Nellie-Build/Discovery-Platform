# Adaptive discovery candidate ranking

Normal requests send the target and breadth, without technical limits. The server resolves
the budget using `effort = targetRecords × breadthFactor × moduleFactor`. Breadth factors are
0.75 (focused), 1 (standard/advanced/unknown), and 1.5 (broad). The vacancy module factor is
2.5; the generic fallback is 2.

- `maxPages = ceil(5 + effort)`, capped at 200.
- `maxCandidates = ceil(20 + 4 × effort)`, capped at 500 waiting candidates.
- `maxDurationMs = ceil(30,000 + 2,000 × effort)`, capped at 240,000 ms.
- Explicit finite Advanced limits override individual fields, still clamped server-side.
  Missing fields stay adaptive. `budgetSource` is computed by the server; clients cannot set it.

| Standard target | Pages | Waiting candidates | Duration cap |
| --- | ---: | ---: | ---: |
| 10 | 30 | 120 | 80,000 ms |
| 50 | 130 | 500 | 240,000 ms |
| 100 | 200 | 500 | 240,000 ms |

These are ceilings, not promises: robots delays, HTTP failures and time limits can prevent a
target from being reached. No crawl delay is shortened to hit a target.

## Pipeline and evidence

Requested URL/homepage/sitemaps/links → normalized URL → domain classification and ranking →
bounded priority queue → HTML fetch → domain extraction/validation → date filter/dedupe → record.
The requested URL is always processed first. Every subsequent dequeue selects the highest score,
with insertion order breaking ties. A newly discovered strong candidate can replace the weakest
waiting candidate at capacity. Already processed canonical URLs are never queued again.

Core exposes candidate evidence and the queue; `domains/vacancies` supplies these signals:

| Signal | Score change |
| --- | ---: |
| Starting score | 10 |
| Vacancy/jobs/careers path | +20 |
| Detail-shaped path | +45 |
| Job-title anchor | +25 |
| Distinct detail slug | +5 |
| Detail found in sitemap | +10 |
| Detail found on listing | +10 |
| Homepage | −15 |
| Contact/privacy/terms/news/login/account navigation | −90 |
| Category overview | −25 |
| Search/filter query | −30 |
| Pagination | −20 |

Scores ≥60 are high confidence; 20–59 medium; <20 low. Classification is evidence, not acceptance:
even a high-scoring URL must pass the existing extractor, date filter and dedupe. No hostname
checks, website-specific selectors, AI ranking, Crawlee or Playwright were added.

Three or more detail-shaped links identify a listing for discovery purposes. Every valid link
within the existing 2,000-anchor safety cap is considered with its own score; navigation does not
receive the detail bonus. Pagination stays eligible to discover further listings. Sitemap indices
are followed within the shared eight-metadata-request cap (including robots). A sitemap may expose
up to 50,000 entries under the existing 2 MiB response cap, independently of the page/queue budgets.

Stopping checks run after extraction, before sitemap discovery or another page request. Rejected
pages do not trigger another full dedupe evaluation when no new facts were extracted. Accepted
output is capped exactly at the target, including pages with multiple JobPosting nodes.

## Statistics

- `urlsDiscovered`: URL occurrences encountered, including repeated or subsequently rejected links.
- `uniqueUrlsDiscovered`: distinct normalized in-scope page URLs.
- `candidateUrlsFound`: distinct eligible candidate URLs classified, including candidates that
  could not be retained in the bounded waiting queue. It can exceed `maxCandidates`.
- `sitemapUrlsFound`, `listingUrlsFound`: occurrences from those discovery sources.
- `sitemapCandidatesAccepted/Rejected`: sitemap occurrences accepted as in-scope, visited/already
  queued or offered successfully to the queue, versus invalid/out-of-scope/capacity-rejected entries.
  A candidate accepted earlier can subsequently be displaced by a better one.
- `candidatesProcessed`: logical candidates handled; `pagesVisited`: actual page requests, including
  redirect hops. Neither includes robots/sitemap requests.
- `candidatesRemaining`: actual waiting queue, excluding processed URLs and discarded candidates.
- Confidence counts describe the classified candidate set. Candidate diagnostics preserve canonical
  URL, source, discovery parent, classification, `candidateScore`, and `candidateReasons`.
- Existing extraction acceptance/rejection, record, duplicate, duration, limit and stop statistics
  remain available. The UI separates URL discovery from candidate processing and exposes budgets
  and confidence in “Technische details”.

`knownCandidates` compares canonical URLs with existing record source URLs; `newCandidates` is
the complement. Core can compare a caller-provided previous hash with the existing fetched SHA-256
to report `unchangedCandidates`. The API currently has no persisted per-candidate hash history, so
it passes known URLs without hashes and does **not** claim those URLs are unchanged or skip them.
Persistent hash storage, conditional requests, a scheduler and distributed caching are deferred.

## Verification

Unit tests use injected transports and clocks, never live websites. Existing WBO/SPIE extraction,
direct-URL, date-filter, duplicate, branch-mode and SSRF suites remain part of `npm test`.

Local validation: production build and typecheck passed; 430 distinct tests passed (428 in the
full suite, plus two final crawler regressions). After the final queue evidence correction,
all 101 core tests and 22 targeted ranking/API regression tests passed again. Tests used an
NTFS temporary copy with the committed lockfile because the source checkout is on exFAT,
which cannot create npm workspace junctions. No dependencies or lockfile were changed.

After deployment, run:

```sh
node scripts/verify-adaptive-discovery.mjs <Discovery-Platform-Cloud-Run-URL> docs/adaptive-discovery-live.json
```

The live check uses Standard mode without Advanced overrides and separate projects for WBO
targets 10, 50 and 100 and SPIE target 10. It saves the measured counters and compares against
the supplied historical WBO baseline of 102 page requests for 50 records. No fixed page-count
threshold is imposed. Counts alone do not prove identity with the historical 50 vacancies.

Future Crawlee work may revisit scheduling, concurrency and persistent queues. The bounded serial
queue here is simple enough that Crawlee is not needed for this optimization.
