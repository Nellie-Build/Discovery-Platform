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
