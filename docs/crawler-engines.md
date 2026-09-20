# Crawler engines

Website discovery can run on two crawl engines behind one domain-neutral interface. The engine is
chosen by server configuration only; **`legacy` is the default** and nothing selects `crawlee`
automatically (no fallback from one to the other).

| | `legacy` | `crawlee` |
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
parseCrawlerEngine(process.env.DISCOVERY_CRAWLER_ENGINE)   // anything but "crawlee" is "legacy"
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

- `DISCOVERY_CRAWLER_ENGINE=legacy|crawlee` (default `legacy`), set by the deploy workflow input
  `crawler_engine` (default `legacy`).
- `DISCOVERY_CRAWLER_CONCURRENCY` (1-3, default 2; crawlee only).

## Known considerations

- Crawlee keeps everything in memory (no `storage/` directory) and is loaded only when selected.
- Crawlee's autoscaling samples memory/CPU with `ps` and `getconf` on Linux. `node:24-slim` has no
  `ps`, so on Cloud Run each sample fails and is logged (once per 30 s in this setup); it does not
  stop the crawl. Install `procps` in the runtime image before promoting the engine.
- The deliberate behavioural difference between the engines is retrying; results otherwise match
  (see `tests/crawler-contract.test.mjs`, which runs one contract against both engines).
- Not built yet: browser rendering (Playwright), engine fallback, a queue shared between runs.
