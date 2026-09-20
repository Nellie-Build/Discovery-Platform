# Crawler engines

Website discovery runs on one of two crawl engines behind one domain-neutral interface. The engine is
chosen by server configuration only.

- **Primary: `crawlee`** (`CrawleeCrawler`), the default since the promotion described below.
- **Rollback: `legacy`** (`LegacyHttpCrawler`), kept for at least one further release phase and
  selected only by an explicit `DISCOVERY_CRAWLER_ENGINE=legacy`.
- **There is no automatic fallback.** If Crawlee fails, the run shows the crawler failure (see
  "Runtime diagnostics and infrastructure failures"); rolling back is a configuration/deployment
  change, never something the crawler does by itself, so a failure is never hidden.

| | `legacy` (rollback) | `crawlee` (primary) |
|---|---|---|
| Class | `LegacyHttpCrawler` | `CrawleeCrawler` |
| Scheduling | serial loop, best remaining candidate next | Crawlee `BasicCrawler` + `RequestQueue`, 1-3 pages in flight |
| Retries | none | up to 2 retries of a page after a transient failure (network error, timeout, HTTP 5xx) |
| Fetching, robots.txt, redirects, limits | shared policy layer | the same shared policy layer |

## Interface (`packages/discovery-core/src/crawler/discovery-crawler.ts`)

```ts
interface DiscoveryCrawler {
  readonly engine: 'legacy' | 'crawlee';
  crawl(website, options): Promise<CrawlResult>;   // same options and result for every engine
  fetchPage(url, options): Promise<SinglePageFetchResult>;
}
createDiscoveryCrawler(engine, { maxConcurrency?, maxRequestRetries? })
parseCrawlerEngine(process.env.DISCOVERY_CRAWLER_ENGINE)   // only an explicit "legacy" is legacy; everything else is "crawlee"
```

The engines know nothing about the domain: a page goes to the caller's `extract` callback, and
everything after the crawl (extraction, plausibility, scoring, de-duplication, persistence) is
identical for both. Branch discovery (ts-jobspy) does not use a crawl engine and is unchanged.

## One policy layer

`createCrawlSession()` in `website-crawler.ts` holds everything that decides *whether* and *how* a
URL may be fetched: URL scope (http/https, no credentials, same domain and port, no binary files),
robots.txt (fail closed), crawl delay (2 s minimum, or the site's `Crawl-delay`), redirect validation
(each hop re-checked, at most 3, never off-domain), page/request/time budgets, the SSRF-safe
transport (`fetchPublicUrl`: public addresses only, DNS pinned, 2 MiB limit), candidate ranking,
sitemap discovery and result building. `crawlWebsite()` (the legacy engine) is a serial loop over
that session; `CrawleeCrawler` is a queue-driven loop over the same session. Crawlee's own HTTP
client is **not** used: `BasicCrawler` only schedules, and every fetch is `session.crawlPage()`.
Only URLs that already passed our normalisation are ever handed to Crawlee's queue.

## Priority mapping

Crawlee v3's `RequestQueue` is first-in-first-out (no numeric priority). The candidate ranking
(`rankCandidate` → `candidateScore`, `candidateReasons`, classification) stays the only source of
order, kept in the session's `CandidateQueue` for both engines. The Crawlee engine tops Crawlee's
queue up from it in batches of `2 × maxConcurrency` requests, best-ranked first, so newly found
high-ranking pages jump ahead of everything not yet queued. The requested URL is queued alone and
finished (plus the sitemap lookup) before any other page is queued.

## Concurrency and politeness

`maxConcurrency` is 2 by default (1-3, `DISCOVERY_CRAWLER_CONCURRENCY`). Every request (page,
robots.txt, sitemap) reserves its start slot one crawl delay after the previous one, so concurrency
never makes the crawl faster than the site's politeness allows; it overlaps network latency with the
delay. The page budget is reserved before waiting, so `maxPages` is exact. When the target is
reached, no new page is queued or started; requests already running finish (the extracted pages may
exceed the target by up to `maxConcurrency`, and the run's own target cut-off still applies).

## Diagnostics (`stats` of a website run, identical meaning for both engines)

`crawlerEngine`, `requestsQueued` (distinct URLs queued), `requestsStarted`, `requestsSucceeded`,
`requestsFailed`, `requestsRetried`, `maxConcurrencyUsed`, `queueRemaining`, `durationMs`. Request
counts cover every HTTP request (pages, robots.txt, sitemaps). Older runs simply lack these fields;
the run card shows them under "Technische details" only when present.

## Configuration

- `DISCOVERY_CRAWLER_ENGINE=crawlee|legacy`: unset, empty or unrecognised means **`crawlee`**; only an
  explicit `legacy` (case-insensitive, surrounding spaces ignored) selects the rollback engine. An
  unrecognised value is deliberately the product default, so a typo can never silently move the
  service onto the rollback engine. It is never taken from a request. The deploy workflow input
  `crawler_engine` (choice `crawlee`/`legacy`, default `crawlee`) always sets it explicitly.
- `DISCOVERY_CRAWLER_CONCURRENCY` (1-3, default 2; crawlee only). Not changed by the promotion.
- **Rollback:** run the deploy workflow with `crawler_engine=legacy` (the crawler canary is skipped
  then); switch back with `crawler_engine=crawlee`, which runs the canary.

## Known considerations

- Crawlee keeps everything in memory (no `storage/` directory) and is only loaded when it is the selected engine.
- **`ps` must exist in the runtime image.** Verified live on Cloud Run (`node:24-slim`, which has no
  `ps`): with `DISCOVERY_CRAWLER_ENGINE=crawlee`, `crawler.run()` created its AutoscaledPool and then
  failed *before the first request handler* with `Error: spawn ps ENOENT` (`crawlerFailurePhase: run`,
  `crawlerRequestHandlerCalls: 0`, no page fetched, on every site). An earlier version of this
  document claimed a missing `ps` only causes log messages and does not stop the crawl; that was
  wrong. Crawlee's BasicCrawler takes its system measurements from the AutoscaledPool, and on Linux
  that needs `ps`. The runtime stage of the `Dockerfile` therefore installs `procps` explicitly and
  has a build-time guard (`command -v ps && ps -ef`) so the image build fails if `ps` disappears.
  The legacy engine does not use Crawlee and never needed it.
- The deliberate behavioural difference between the engines is retrying; results otherwise match
  (see `tests/crawler-contract.test.mjs`, which runs one contract against both engines).
- Not built yet: browser rendering (Playwright), automatic engine fallback (deliberately not planned:
  it would hide failures), a queue shared between runs.

## Why Crawlee became the primary engine

The decision rests on a live comparison on the shared test environment (Cloud Run, commit
`1bdb1e0`), target 50 per site, new projects for every run:

- The Cloud Run runtime problem is solved: the runtime image installs `procps` (with a build-time
  guard); `spawn ps ENOENT` is gone and the crawler canary passes.
- The WBO extractor false negative is fixed (`looksLikeOverviewPage`): no real detail page was
  rejected as an overview in any of the runs (before: 65 of 66 `overview_page` rejections were real
  vacancies). Both engines reach 50 records with `target_reached` on WBO.
- The requested URL is the first page processed by both engines (first `pageDiagnostics` entry).
- Target and limits hold: `target_reached`, records capped at the target; an overshoot of one page
  (well within `maxConcurrency`) was seen.
- SPIE parity: the same 50 records by URL (50 of 50 overlap) from both engines. WBO: 50 records each,
  all real vacancy detail pages, though a different 50 (26 of 50 shared by URL) because almost all
  WBO candidates have the same ranking score; the choice among equals depends on discovery order.
- No runtime or security regressions: no failure phase, no `ps`/memory/cgroup/storage errors, the
  shared policy layer (robots, scope, redirects, SSRF-safe transport) is the same for both engines.
- Concurrency is used live (`maxConcurrencyUsed = 2`) and the run diagnostics are present.
- Speed is **not** a reason: it is about the same (roughly 28-29 pages per minute for both
  engines), because the 2 second crawl delay between request starts applies to both. What Crawlee
  adds is queueing, retries after transient failures and diagnostics, not throughput.

## Runtime diagnostics and infrastructure failures

The Crawlee engine records how far it got and why it stopped, in the website run statistics (and
under "Crawler-diagnose" in "Technische details"). Legacy runs have none of these fields.

- `crawlerPhases` (`session_created`, `import_start`, `import_ok`, `configuration_created`,
  `queue_opened`, `crawler_created`, `run_started`, `request_handler_started`, `run_completed` /
  `run_failed`, each with milliseconds since the start) and `crawlerPhase` (the last one reached).
- `crawlerFailurePhase`, the operation that was in progress when something went wrong: `import`,
  `configuration`, `queue_open`, `crawler_create`, `seed`, `run`, `request_handler`, `request_feed`,
  `request_failed` (retries exhausted) or `run_no_requests` (`crawler.run()` finished without ever
  calling the request handler). Only the first failure is kept: later ones are consequences.
- `crawlerErrorName`, `crawlerErrorMessage` (max 1000 characters), `crawlerErrorCode`,
  `crawlerErrorCause` (max 500) and `crawlerErrorStack` (first 8 lines, max 2000 characters). Query
  strings and fragments of URLs are removed; no environment variables, headers or tokens are ever
  included.
- `crawlerQueue` (seed URL/key present, queue opened, request counts before and after the run, from
  the public `RequestQueue.getInfo()`), `crawlerBasicCrawler` (running/finished flags and whether the
  autoscaled pool existed, from public properties only) and `crawlerRuntime` (Node version, platform,
  architecture, booleans for a readable `/proc`, a readable cgroup, a writable temp directory and
  working directory, an existing `storage/` directory, the total OS memory and the cgroup memory
  limit if there is one). Nothing runs a shell command.
- A failure also writes one structured line to the server log:
  `{"event":"crawlee_run_failed","phase":...,"errorName":...,"errorMessage":...,"errorCode":...}`.

Run status: a website crawl whose engine failed, or that did not fetch a single page while the
crawl status is `failed`, is a **failed** run (`stopReason: crawler_failed`, the reason on the run)
and never "succeeded / no_more_candidates". If the engine failed after some pages, the run is
**partial** and keeps its records. Runs that did reach their pages, sites that answer with errors,
and a robots.txt block keep their previous status. For crawls that end `failed` or `blocked`, the
crawler's own error text is kept as `crawlError` in the statistics.

## Crawler canary (separate from the deployment smoke test)

With Crawlee as the default this runs in every deployment that uses it (skipped for a `legacy`
rollback deployment).

The deployment smoke test only checks that a run *finishes*. `scripts/verify-crawler-canary.mjs
<service-url> <legacy|crawlee> [probe-url]` runs one website discovery on a simple public page
(default `https://example.com/`) and requires: the expected `crawlerEngine`, `pagesVisited >= 1`,
`requestsStarted >= 1`, and a crawl and run status that is not `failed`; if not, it prints every
recorded crawler diagnostic and exits with 1. Because it depends on an external page it is not part
of the ordinary smoke test: the deploy workflow runs it only when `crawler_engine=crawlee`.
