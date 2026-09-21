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
