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
`GET /papi/tenderned-rs-tns/v2/publicaties?page&size&publicatieDatumVanaf&publicatieDatumTot[&cpvCodes]` and `/publicaties/{id}`.

* Filters: `publishedFrom`, `publishedTo` (YYYY-MM-DD, at most 90 days, default the last two days, never a bulk import; walked newest first in seven-day blocks), `cpvPrefixes` (server-side via the list endpoint's hierarchical `cpvCodes` parameter, `<8 digits>-0`: TenderNed matches on the digits and ignores the check digit, verified 2026-09-24; checked again client-side from the detail), `nutsPrefixes` (client-side, decided from the detail document).
* CPV prefixes are categories everywhere (TenderNed, TED, web): trailing zeros of a full code are hierarchy padding, so `92111000` means `92111…` and covers subcategory `92111200` (`parseCpvPrefixes`).
* Cursor: `"<page>:<pageSize>[:<block>]"`; the page size is fixed when a walk starts.
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

* Filters (server-side, part of the expert query): `publishedFrom`/`publishedTo` (same bounded range as TenderNed: default two days, at most 90), `country` (buyer country, ISO alpha-3, default `NLD`), `cpvPrefixes` (`classification-cpv=45*`), `nutsPrefixes` (`place-of-performance=NL41*`), `keywords` (full text: each literal word as `FT~"word"`, OR-ed; operators typed by the user are never passed through). `scope: ALL` includes notices whose deadline has passed, so the run can report them as expired. One request returns up to 250 notices with exactly the fields the mapping needs, so there is no detail request. Paging is `PAGE_NUMBER` (`"<page>:<pageSize>"` cursor) in the API's stable ascending publication-number order; a query that matches more than the pageable 15,000 is refused with advice to narrow it.
* Identity: tender = `procedure-identifier` (shared by the contract notice, corrections/modifications and the award notice of one procedure), else `notice-identifier` (prior-information and market-consultation notices have no procedure); publication = `publication-number`. Provenance is per TED publication (`record_sources` row and `publications[]` entry with its own link).
* Mapping: title from `title-proc` (Dutch, else English, else the first language; then `title-lot`, then `notice-title`), buyers (all named), procedure/notice/contract labels (Dutch, unknown codes kept), CPV codes (merged over lots, first is main), NUTS codes from `place-of-performance` (three-letter entries are countries and dropped; no place names, so `location` stays null), earliest lot deadline converted to Dutch local time, estimated value = procedure value, else the sum of the lots when every lot states one in one currency, else null. TED has no buyer reference number.
* TED notices of one procedure merge into one record, exactly like TenderNed publications of one kenmerk (see "Updating stored tenders").

## Cross-source matching

TenderNed and TED records are **never merged by identity**: each source has its own identity space (`sourceSystem` is part of the key), and a test asserts that equal-looking identifiers do not collide. Measured on live data (TED: 470 Dutch-buyer tenders published 15–21 September; TenderNed: 1083 tenders published 8–21 September, 919 flagged European), on tenders present in both:

* TenderNed's detail document states the TED publication number of a publication (`pbNummerTed`, e.g. `643394-2026`); the list entry does not, and TED carries no `kenmerk`. (The measurements below predate this finding.)
* Normalised title + contracting authority matched 433 pairs one-to-one; the title alone 447 (11 ambiguous keys, 19 with a different authority string because TED lists every buyer of a joint procurement, TenderNed the lead buyer). Adding the deadline: 238 pairs, 1 ambiguous key.
* Of the 236 pairs where both sources state a deadline, 235 agree to the minute once TED times are converted to Dutch local time; the one difference is a deadline that TenderNed's correction moved and TED had not published yet.
* Contract type agreed in 419 of 433, procedure in 370 (TED has no label for some procedure types).

Proposal: keep two records and store a **link**, not a merge. A link needs, at once: equal normalised title, the TenderNed authority among the TED buyers, a unique match in both directions, and (when both have one) the same deadline; that is `same_tender` with high confidence. A title + authority match without a comparable deadline is `possible_same_tender` (shown, never automatic). Title alone or authority + deadline alone are never links. If TenderNed's credentialed XML API turns out to include the TED notice number, that becomes an exact key and replaces the heuristic.

**Implemented: explicit links only** (`tender-links.ts`, 2026-09-25). The TenderNed mapping keeps `pbNummerTed` as the publication's `tedPublicationNumber` (only when stated and well-formed). `linkTenders` links a TenderNed and a TED record only when that number is one of the TED record's own publication numbers; titles, authorities and deadlines never link. It is a view: both records, their identities and publication histories stay stored separately and unchanged. `combineLinkedTenders` gives one tender with, per field, the first source that states it (TenderNed, then TED) and that source's name, so a deadline that only TenderNed publishes is shown as TenderNed's and never written into the TED record; an award on either source makes it expired. The web list (`DomainRenderer.groupRecords`) shows a linked pair as one row with both source links and each source's own notice and deadline; the detail page still shows one stored record.

Records stored before this field existed get it the next time a run sees that TenderNed publication again (the record is then marked updated once). Until then they are shown unlinked.

## Websites and web search (`sourceId: "website"`, `"search"`, `"auto"`)

Tenders that are on no API are found through the same `DiscoverySource` interface, with the platform's one crawl engine (Crawlee by default; no second crawler) and one configurable search provider — Tavily (`TAVILY_API_KEY`) or Brave (`BRAVE_SEARCH_API_KEY`), picked by `SEARCH_PROVIDER` or by whichever key is set (Tavily first) when it is not; see `createConfiguredSearchProvider` in discovery-core. That resolver is domain-neutral and available to any caller, but today only `apps/api/src/domains/tenders-adapter.ts` uses it — Vacancies' own adapter still resolves Brave only. Neither provider is Tenders-specific: the choice lives entirely in the domain-neutral core, domains/tenders never names either provider. `language` is forwarded to whichever provider is configured; `country` is forwarded to Brave (it genuinely only biases Brave's ranking) but deliberately never to Tavily — measured against Tavily's real API, its own `country` field does not merely bias results as documented, it silently drops otherwise-good results to zero for some queries. Either way, no provider's own geographic filtering is trusted as the actual answer to "is this the right country" — a `search`/`auto` run also judges the actual result itself (see below).

A `search`/`auto` run never presents an explicitly foreign page as a tender of the requested country: `tender-page.ts`'s `assessTenderPage` reads a page's own country evidence (its host's country-code top-level domain, from a curated safe subset that excludes ccTLDs commonly resold as vanity domains such as `.io`/`.ai`/`.co`/`.me`/`.tv`; or a structured `addressCountry` the page's own JSON-LD states as a plain ISO code) and `web-sources.ts` excludes a page that explicitly names a different country (rejection reason `foreign_country`), never merely deprioritises it. A page with no reliable country evidence of its own is not rejected for that alone — it is kept, but its record's `discovery.locationConfidence` is `'unconfirmed'` rather than `'confirmed'`, so a caller/UI can tell the two apart instead of presenting every web result as equally certain. A `website` run has no target country (it crawls one already-chosen site) and never sets this field at all.

| sourceId | What it does | Filters |
|---|---|---|
| `website` | Crawls one organisation website (homepage, an overview or one tender page). A `{ sourceUrl }` run is this source. | `url`, `cpvPrefixes`, and the run's page/candidate/time limits |
| `search` / `auto` | **API-first** (`search-plan.ts`): TED (full text, CPV, buyer country, server-side), then TenderNed (Netherlands only, CPV server-side, keywords client-side), then the web search as a supplement for tenders outside the official sources — only with keywords or a CPV category (its official label becomes the query) and a configured provider (Tavily/Brave). Official records fill the wanted number first. A failing source, a time limit or a detail failure makes the run `partial` (`coverageComplete: false`). `sources` narrows the steps (`["search"]` is the former web-only mode). | `branch`, `keywords`, `country`, `region`, `cpvPrefixes`, `nutsPrefixes`, `publishedFrom/To`, `maxQueries`, `sources` |

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

**Backlog — geographic filtering** (known limits of the country check above, not yet addressed):
- Most results end up `unconfirmed`: generic TLDs (`.com`, `.app`, `.eu`, ...) and vanity ccTLDs carry no country, and few pages publish a structured `addressCountry`. The check only removes *explicitly* foreign pages; it does not prove a page is domestic.
- No other evidence is read yet: a postal code or address in the page text, a NUTS code, a Dutch KvK number, the contracting authority's own name, or the page's `lang`. Each needs care to avoid guessing (Dutch text is not a Dutch buyer; Belgium also writes Dutch).
- Supranational buyers (EU institutions on `europa.eu`) are neither foreign nor domestic; they stay `unconfirmed` and there is no rule yet for whether they belong in a national run.
- An aggregator's ccTLD or `addressCountry` describes the aggregator, not the buyer of the tender it lists: a Dutch aggregator listing a Belgian tender reads as `confirmed`.
- The ccTLD safe list and the vanity exclusions are a hand-kept table in `tender-page.ts`.
- Tavily's `country` parameter is not used (it drops good results). Whether a query-side bias (e.g. adding the country name to the query) helps recall without hurting it is unmeasured.
- `locationConfidence` is stored but not yet shown or filterable in the web UI, and `foreign_country` rejections are only visible in the run statistics.

## Source role, publisher and contracting authority (hardening)

**Source role** (`source-role.ts`, general signals, never a hostname): every web page is judged as `official_organization_site` (the publisher is the contracting authority; the domain is named after the publisher; the text speaks of "our" procurements), `aggregator` (the site presents itself as a tender/procurement platform, the authority differs from the publisher, the publisher is named as a tender service, or one host shows three or more different contracting authorities) or `unknown_web_source` (the default). Confidence and evidence are kept. A host's role is settled per run from all its pages and the authorities of its accepted tenders.

**Publisher versus contracting authority** are separate concepts. The publisher (who runs the site) comes from structured data or site metadata and is stored in `discovery.publisher`. The contracting authority is only what the page states, by precedence: structured data (`buyer`/`contractingAuthority` in JSON-LD, or a contracting-authority meta tag), an explicit label (aanbestedende dienst, opdrachtgever, contracting authority/entity, buyer, ...), or a labeled sentence ("De opdrachtgever is Gemeente X."). The site name or publisher is never used; no authority stays `null`. `discovery.authoritySource` says which of the three it was.

**Provenance of a page tender** (`discovery`): `via`, `mode` (`website`, `search`, `auto`), host, `sourceRole` + `roleConfidence` + `roleEvidence`, `publisher`, `authoritySource`, the search `query` and provider, the page it was `discoveredFrom`, and the `evidence` signals. It records the FIRST discovery: finding the same page again through another mode or with another role verdict does not update the record. TenderNed and TED keep their own provenance and have no `discovery`.

**robots.txt for search results.** Investigation: `fetchAndExtractPage` in the core is deliberately "one known URL, no robots/sitemap" (also used by the vacancies job-board enrichment and search), so search results were fetched without a robots check while crawls always checked. Fix: a small domain-neutral core primitive `createRobotsPolicy` (`crawler/robots.ts`): the same fail-closed rules as the crawl (only 200/404/410 count as readable), the same SSRF-safe transport, one robots.txt request per origin per run, and no request to the page itself when it is forbidden. It is opt-in through `fetchAndExtractPage(..., { robots })`, so Vacancies behave exactly as before; the tender search step passes it. The later site crawl of an overview lead reads that origin's robots.txt once more in its own session (a second robots.txt request, never a page).

**Keywords to CPV.** The web form suggests categories from the official CPV 2008 vocabulary (`src/cpv-data.ts`, NL/EN labels; source, checksum and reuse terms in `data/README.md`) by literal label or code match (`suggestCpv`). There are no AI or hand-made synonyms. The one explicit disambiguation is `video`: videoproductie `92111000` and audiovisuele apparatuur `32321200` are offered as two separate choices and never combined automatically.

**Run outcome** (stats): `officialTenders`, `webResults`, `opportunityStatus` (`open` / `expired` / `unknown`, from `tenderOpportunityStatus`: award/cancellation notices are expired, a missing or same-day date-only deadline is unknown), `openRelevant` (open, and for web results a confirmed country and matching CPV), `coverageComplete` and `yield` (`no_matches`, `no_confirmed_open_matches`, `open_matches`). The summary separates "the run succeeded" from "it produced relevant open tenders", and explains zero results.

**Acceptance (2026-09-24, NL, published 2026-08-26 – 2026-09-24).** Same filters queried directly on TED and TenderNed: `92111000` TED 1 / TenderNed 1; `32321200` TED 2 / TenderNed 2; the run found exactly these: 6 official records = 3 distinct tenders, each on both TED and TenderNed (kept as separate records, see "Cross-source matching"), of which 2 open (one only open per TenderNed: TED states no tender deadline for that restricted procedure, so there it is `unknown`); 0 web supplements.

**Cross-source overlap** is only reported, never merged (see "Cross-source matching").
