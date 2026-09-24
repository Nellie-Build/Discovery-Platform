# Tenders / aanbestedingen (phase 1: one vertical slice)

Local-only MVP: one TenderNed run, end to end, on the same generic run/record persistence as vacancies.

## Pieces

| Where | What |
|---|---|
| `packages/discovery-core/src/source/discovery-source.ts` | Domain-neutral `DiscoverySource` (`id`, `kind: 'api' \| 'feed' \| 'website'`, `fetchBatch({ cursor, filters, limit })` → `{ items, nextCursor, exhausted }`), `SourceItem` (`externalId`, `sourceUrl`, `fetchedAt`, `raw`), `SourceError` and `collectFromSource` (a bounded walk: items, batches, time; never loops without progress). No tender vocabulary (checked by a test). |
| `domains/tenders` | `TenderFacts`, the TenderNed API source (public JSON list + detail), JSON → facts mapping, merging of publications, tender identity and a small completeness score. |
| `apps/api/src/domains/tenders-adapter.ts` | The `DomainAdapter`: collect → map → merge → skip stored tenders → records. |
| `apps/api/src/routes/runs.ts` | A third run shape: `{ sourceId, filters?, runConfig? }` next to `{ sourceUrl }` and `{ branch }`. |
| `packages/discovery-db/migrations/007_tenders_module.sql` | Registers the `tenders` module, **disabled** (enable via `PATCH /admin/modules/tenders`). No new table. |

## TenderNed source

Public endpoints, no credentials (data is CC0; the JSON shape is not an official contract, so every field is optional and validated):
`GET /papi/tenderned-rs-tns/v2/publicaties?page&size&publicatieDatumVanaf&publicatieDatumTot` and `/publicaties/{id}`.

* Filters: `publishedFrom`, `publishedTo` (YYYY-MM-DD, at most 14 days, default the last two days, never a bulk import), `cpvPrefixes`, `nutsPrefixes` (client-side, decided from the detail document).
* Cursor: `"<page>:<pageSize>"`; the page size is fixed when a walk starts.
* Pace: one request at a time, at least 300 ms apart, 15 s timeout, two retries for 429/5xx/timeouts only (Retry-After honoured, capped at 30 s). A failed detail request keeps the list data and is counted (`detailFailures`); a CPV/NUTS filter cannot vouch for an item without detail.
* Errors are `SourceError`s with a code: `timeout`, `http`, `invalid_response`, `invalid_filters`, `aborted`; a failed source makes the run `failed` with that message.

## Identity (MVP)

* Tender identity = `sourceSystem` + `kenmerk` (`tenderned|567798`); a publication without a kenmerk is its own tender (`publicatie-<id>`).
* Publication identity = `publicatieId`.
* Several publications of one tender (announcement, correction, ...) are **one record**: each field takes the value of the latest publication that has one, `publicationId`/`noticeType`/`publicationDate` describe the latest publication, `publications[]` lists all of them. Corrections and awards are not separate records.
* Across runs a stored tender is recognised by its identity and never created again. A newer publication of it **updates the stored record** (see below).

## Updating stored tenders

When a run finds publications of a tender that already has a record in the project (same source system + kenmerk):

* the publication is added to `publications[]` (each publication id once) and its provenance row is added to `record_sources`;
* every field takes the value of the latest publication that has one (`noticeType`, `publicationId`, `publicationDate`, deadline, procedure, CPV/NUTS, description, ...); a later publication without a field keeps the earlier value; on the same publication id the freshly fetched values win; an older publication seen late only fills gaps;
* nothing is written when the merged facts equal the stored ones, so the same run twice leaves `discovery_records`, `record_sources` and `record_contacts` untouched (including `updated_at`);
* no second record is ever created for the same tender.

The adapter returns `updatedRecords` (changed) and `observedRecords` (unchanged); the run route stores them and reports `recordsCreated`, `recordsUpdated` and, from the adapter, `duplicatesUnchanged` in the run statistics (`duplicatesAgainstExisting` = updated + unchanged). Updates are scoped to the run's own project, and `DiscoveryRecordsRepository.updateRecordFacts`/`addSourcesIfMissing` do the writes.

## Not in this phase

Web UI (the generic renderer shows tender records), estimated values (TenderNed's JSON has none; the field exists and is filled only when a source states one), TED, feeds, website sources, deploying.

## Web UI (minimal)

All tender knowledge in the Web App lives in `apps/web/src/domains/tenders/` (renderer, run form, run summary); the generic components only call the `DomainRenderer` (a test checks that they contain no tender vocabulary). The registry got three optional hooks: `RunPanel` (the domain's own "start a run" form), `RunSummary` and `renderDetailSections` (extra sections on the record page).

* Projects: "Tenders" is offered as a domain; while the module is disabled the API refuses the project ("module is currently disabled").
* Tender project page: a TenderNed run form (`sourceId: 'tenderned'`; published from/to, CPV prefix, NUTS prefix, wanted number) instead of the website/branch form, and a run summary with created / updated / unchanged.
* List: title, contracting authority, deadline, procedure, CPV, location/NUTS, latest publication type, and a "Bijgewerkt" badge for records that a later publication updated.
* Detail: all `TenderFacts`, the source link, a publication history from `publications[]` (newest first) and a notice when the record was updated later.
* `packages/discovery-client`: `runs.startSourceRun(projectId, { sourceId, filters?, runConfig? })`.

## TED source (`sourceId: "ted"`)

The official TED Search API v3 (`POST https://api.ted.europa.eu/v3/notices/search`, anonymous, JSON); `domains/tenders/src/ted-source.ts` and `ted-map.ts`. A `TenderSourceDefinition` registry (`sources.ts`) lets the tenders adapter run any source through the same collect → map → merge → update flow; core is unchanged.

* Filters (server-side, part of the expert query): `publishedFrom`/`publishedTo` (same bounded range as TenderNed: default two days, at most 14), `country` (buyer country, ISO alpha-3, default `NLD`), `cpvPrefixes` (`classification-cpv=45*`), `nutsPrefixes` (`place-of-performance=NL41*`). One request returns up to 250 notices with exactly the fields the mapping needs, so there is no detail request. Paging is `PAGE_NUMBER` (`"<page>:<pageSize>"` cursor) in the API's stable ascending publication-number order; a query that matches more than the pageable 15,000 is refused with advice to narrow it.
* Identity: tender = `procedure-identifier` (shared by the contract notice, corrections/modifications and the award notice of one procedure), else `notice-identifier` (prior-information and market-consultation notices have no procedure); publication = `publication-number`. Provenance is per TED publication (`record_sources` row and `publications[]` entry with its own link).
* Mapping: title from `title-proc` (Dutch, else English, else the first language; then `title-lot`, then `notice-title`), buyers (all named), procedure/notice/contract labels (Dutch, unknown codes kept), CPV codes (merged over lots, first is main), NUTS codes from `place-of-performance` (three-letter entries are countries and dropped; no place names, so `location` stays null), earliest lot deadline converted to Dutch local time, estimated value = procedure value, else the sum of the lots when every lot states one in one currency, else null. TED has no buyer reference number.
* TED notices of one procedure merge into one record, exactly like TenderNed publications of one kenmerk (see "Updating stored tenders").

## Cross-source matching (research, not implemented)

TenderNed and TED records are **never merged by identity**: each source has its own identity space (`sourceSystem` is part of the key), and a test asserts that equal-looking identifiers do not collide. Measured on live data (TED: 470 Dutch-buyer tenders published 15–21 September; TenderNed: 1083 tenders published 8–21 September, 919 flagged European), on tenders present in both:

* TenderNed's public JSON carries **no TED reference** (no publication number or notice identifier), and TED carries no `kenmerk`, so there is no exact key.
* Normalised title + contracting authority matched 433 pairs one-to-one; the title alone 447 (11 ambiguous keys, 19 with a different authority string because TED lists every buyer of a joint procurement, TenderNed the lead buyer). Adding the deadline: 238 pairs, 1 ambiguous key.
* Of the 236 pairs where both sources state a deadline, 235 agree to the minute once TED times are converted to Dutch local time; the one difference is a deadline that TenderNed's correction moved and TED had not published yet.
* Contract type agreed in 419 of 433, procedure in 370 (TED has no label for some procedure types).

Proposal: keep two records and store a **link**, not a merge. A link needs, at once: equal normalised title, the TenderNed authority among the TED buyers, a unique match in both directions, and (when both have one) the same deadline; that is `same_tender` with high confidence. A title + authority match without a comparable deadline is `possible_same_tender` (shown, never automatic). Title alone or authority + deadline alone are never links. If TenderNed's credentialed XML API turns out to include the TED notice number, that becomes an exact key and replaces the heuristic.

## Websites and web search (`sourceId: "website"`, `"search"`, `"auto"`)

Tenders that are on no API are found through the same `DiscoverySource` interface, with the platform's one crawl engine (Crawlee by default; no second crawler) and one configurable search provider — Tavily (`TAVILY_API_KEY`) or Brave (`BRAVE_SEARCH_API_KEY`), picked by `SEARCH_PROVIDER` or by whichever key is set (Tavily first) when it is not; see `createConfiguredSearchProvider` in discovery-core. That resolver is domain-neutral and available to any caller, but today only `apps/api/src/domains/tenders-adapter.ts` uses it — Vacancies' own adapter still resolves Brave only. Neither provider is Tenders-specific: the choice lives entirely in the domain-neutral core, domains/tenders never names either provider.

| sourceId | What it does | Filters |
|---|---|---|
| `website` | Crawls one organisation website (homepage, an overview or one tender page). A `{ sourceUrl }` run is this source. | `url`, `cpvPrefixes`, and the run's page/candidate/time limits |
| `search` | Turns branch/keywords/region into web searches, fetches the results, judges every page, and crawls the site behind an overview once. A `{ branch, keywords, region, country }` run is this source. | `branch`, `keywords`, `country`, `region`, `cpvPrefixes`, `maxQueries` |
| `auto` | Every suitable source: TenderNed (Netherlands only), TED and, when a branch or keywords are given and a provider is configured, `search`. Keywords filter the TenderNed/TED results by word; the wanted number is shared between sources. A failing source makes the run `partial`. | all of the above, `publishedFrom/To`, `nutsPrefixes`, `sources` |

**Search queries** (`tender-search.ts`): one query per generic tender intent (`aanbesteding`, `offerteaanvraag`, `opdracht leverancier`, `inkoopkalender`, `marktconsultatie`, `inkoop`, `tender`, `request for proposal RFP`, `request for quotation RFQ`, `procurement`), followed by the branch, the keywords and the region exactly as typed. Dutch intents first for NL/BE, English first elsewhere. Branch and keywords are separate fields; nothing is translated or expanded, and no branch is hardcoded. Only the finished string reaches the core.

**Which page is a tender** (`tender-page.ts`, no site-specific rules): `assessTenderPage` returns `detail`, `overview`, `general` or `none`, with the signals and, for rejections, a reason (`overview_page`, `general_procurement_information`, `insufficient_evidence`, `no_tender_evidence`, plus `cpv_mismatch` / `fetch_failed` in the run statistics).
- Strong signals: a deadline, a reference number (must contain a digit), CPV codes, a *labeled* procedure, downloadable documents. Supporting: a publication date, a labeled contracting authority, tender wording in the title or opening text.
- A page is ONE tender with a title, at least two strong signals and an intent (tender wording, or a reference/CPV), or one strong signal plus tender wording in the title plus a publication date or labeled authority.
- Several tender links and at most one strong signal, or many links with many dates on a listing-style URL, is an overview. A page with its own multi-word slug and two strong signals stays a detail page even if it lists related tenders. Document links (leidraad, bijlage, advies, ...) never count as tenders.
- "How we buy" pages (inkoopbeleid, informatie voor leveranciers, ...) without a deadline or reference are `general` and never a record.
- Deadlines are read day-first (Dutch and English month names) with an optional time; nothing is guessed: missing fields stay null, the contracting authority is never taken from the site name.

**Crawling** (`tender-rank.ts`, `web-sources.ts`): `rankTenderCandidate` classifies links as detail / listing / general / pagination by path and link text, so tender pages are fetched before their overviews and navigation last. A search result that already reads as an overview is not fetched twice: it is the start of one crawl (`skipUrls`, a small domain-neutral core option, keeps the crawl from re-fetching pages the search step already fetched). Within a run a URL is fetched once and a site is crawled once. Pages found by search are single fetches (no robots.txt check, like the vacancy search); crawls honour robots.txt and the crawl delay.

**Identity and provenance**: a page tender's identity is `website` + host/path (no `www`, trailing slash, tracking or fragment; id-like query parameters count). Every record keeps its page URL and `discovery` (`website_crawl` or `web_search`, host, the query, the page it was found from, the evidence signals); `record_sources` gets label `website` or `search`. Tenders from different sources are never merged (see below); the same page seen again is unchanged, and a changed deadline updates the record.

**Web UI**: three modes, clearly apart: *Zoeken* (branch, keywords, country, region, CPV, count), *Directe bron* (TenderNed, TED, Website-URL) and *Automatisch*. The list and detail show the origin (TenderNed, TED, website of an organisation, website found via a search) and, for websites, how it was found.

**Known weak spots**: see the report of the run that introduced this; in short, the source discovery is only as good as the search provider's results (aggregators dominate), free-form pages can lack labels, and there is no JavaScript rendering.

## Source role, publisher and contracting authority (hardening)

**Source role** (`source-role.ts`, general signals, never a hostname): every web page is judged as `official_organization_site` (the publisher is the contracting authority; the domain is named after the publisher; the text speaks of "our" procurements), `aggregator` (the site presents itself as a tender/procurement platform, the authority differs from the publisher, the publisher is named as a tender service, or one host shows three or more different contracting authorities) or `unknown_web_source` (the default). Confidence and evidence are kept. A host's role is settled per run from all its pages and the authorities of its accepted tenders.

**Publisher versus contracting authority** are separate concepts. The publisher (who runs the site) comes from structured data or site metadata and is stored in `discovery.publisher`. The contracting authority is only what the page states, by precedence: structured data (`buyer`/`contractingAuthority` in JSON-LD, or a contracting-authority meta tag), an explicit label (aanbestedende dienst, opdrachtgever, contracting authority/entity, buyer, ...), or a labeled sentence ("De opdrachtgever is Gemeente X."). The site name or publisher is never used; no authority stays `null`. `discovery.authoritySource` says which of the three it was.

**Provenance of a page tender** (`discovery`): `via`, `mode` (`website`, `search`, `auto`), host, `sourceRole` + `roleConfidence` + `roleEvidence`, `publisher`, `authoritySource`, the search `query` and provider, the page it was `discoveredFrom`, and the `evidence` signals. It records the FIRST discovery: finding the same page again through another mode or with another role verdict does not update the record. TenderNed and TED keep their own provenance and have no `discovery`.

**robots.txt for search results.** Investigation: `fetchAndExtractPage` in the core is deliberately "one known URL, no robots/sitemap" (also used by the vacancies job-board enrichment and search), so search results were fetched without a robots check while crawls always checked. Fix: a small domain-neutral core primitive `createRobotsPolicy` (`crawler/robots.ts`): the same fail-closed rules as the crawl (only 200/404/410 count as readable), the same SSRF-safe transport, one robots.txt request per origin per run, and no request to the page itself when it is forbidden. It is opt-in through `fetchAndExtractPage(..., { robots })`, so Vacancies behave exactly as before; the tender search step passes it. The later site crawl of an overview lead reads that origin's robots.txt once more in its own session (a second robots.txt request, never a page).

**Branch to API results (not solved by design).** `auto` filters TenderNed/TED results by the typed *keywords* only, by word (prefix match). A branch such as "Bouw" is not matched against titles, because a branch is a category, not a word: a hardcoded synonym list would be arbitrary. The correct route is branch to CPV divisions/taxonomy: a Tenders-module mapping (or a user-chosen CPV prefix, which both APIs already filter server-side) resolved in `domains/tenders`, ideally from the official CPV vocabulary. Until then, use `cpvPrefixes` for precise API filtering.

**Cross-source overlap** is only reported, never merged (see "Cross-source matching").
