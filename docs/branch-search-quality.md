# Branch search quality and source resilience

## Findings before changes

The project name is not passed to either query builder. `Security Agencies` is a project label;
the branch field `Onderwijs` generated an education search. The old project page displayed
project-wide historical records under the current run and did not allow selecting a historical
run. Form state also persisted when navigating between project IDs without remounting the form.

For branch `Security`, keywords `security agency`, region `Nederland`, the previous queries were:

- Indeed/LinkedIn: `Security security agency`; region separately normalized to Netherlands,
  with Indeed country `netherlands`.
- Web Search: `vacature vacatures jobs Security security agency Nederland`.

No AI expansion existed. The fixed web-search prefix has now also been removed: Web Search uses
`Security security agency Nederland`. The other query builder is unchanged. No project title,
translations of branch terms, inferred synonyms or hidden keywords are added.

The API previously called `markSucceeded` whenever the domain adapter returned normally.
Provider errors were converted to source metadata inside the adapter, so all-source failures
returned normally and were incorrectly persisted as succeeded/provider_exhausted. In addition,
one outer timeout wrapped both job boards and could discard both results before they returned.

The supplied live example proves zero candidates and a provider error, with Web Search disabled.
It does **not** identify the underlying external error (timeout, 429, upstream failure, etc.).
That requires the original run ID/data; no specific external root cause is claimed without it.

## Implemented behavior

- Run outcomes: succeeded for usable source answers (including legitimate empty); partial when
  a usable source answer coexists with an error; failed when no source provides a usable answer.
  Missing optional Web Search does not fail otherwise successful job-board discovery.
- Stop reasons distinguish no_results, provider_exhausted, all_sources_failed,
  source_rate_limited and source_unavailable, alongside existing target/budget stops. Individual
  provider statuses remain available even when target_reached is the primary stop reason.
- Every known provider is visible: ok, empty, partial, error, rate_limited, not_configured,
  user_disabled, unavailable or not_run. Counters distinguish requested, configured/available,
  successful and failed sources. Partial providers count as both a usable answer and a failure.
- Indeed and LinkedIn execute independently with native per-site abort timeouts. Only a transient
  network failure/timeout with no results gets one retry after a short delay. 429 is never retried
  within the run; Retry-After is retained when available. There is no proxy rotation or bypass.
- Source errors are classified and replaced by safe messages. Exception stacks, request headers,
  credentials and arbitrary upstream exception text are not surfaced in the ordinary UI.
- The run criteria are persisted before provider execution and retained on failure. The project
  form resets when switching projects. Run history selects the corresponding criteria and records.
- Non-destructive migration `006_run_records.sql` adds a run/record observation relation with
  immutable result snapshots. The relation supports first/last seen provenance and intermediate
  runs without overwriting history. Rediscovered exact duplicates reuse the project record.
  Existing legacy records are retained; no historical run association is guessed or backfilled.
- “Deze run” reads only those observations; “Alle resultaten” reads the project records. A failed
  run with no observations cannot display historical records as its own results. Missing legacy
  associations are explicitly explained in the UI.
- Relevance retains the existing whole-word, user-term matching and weights. Diagnostics include
  matchedTerms, titleMatches, descriptionMatches, companyMatches, locationMatch and relevanceScore.
  No usable query term means no evidence for acceptance. Location matching is lexical evidence,
  not geographic inference, and is not an additional acceptance gate.

## Remaining limits and live verification

Validation: `npm test` passed all 434 tests; `npm run build` and `npm run typecheck` passed.
The tests ran from the NTFS verification copy with the unchanged committed lockfile, because
the working checkout is on exFAT and cannot host npm workspace junctions. An earlier concurrent
API/UI test invocation exhausted local memory; the complete sequential workspace suite passed.

Lexical relevance can still accept a weak contextual match in a description or company name.
Existing historical duplicate rows are not destructively merged. No scheduler, persistent
provider cooldown, Crawlee, Playwright, new module or crawler engine has been introduced.

After deployment, `scripts/verify-branch-quality.mjs` creates an isolated test project and runs:

- Security / keywords `security officer beveiliging` / Nederland / Standard / target 50.
- Onderwijs / no keywords / Nederland / Standard / target 50.

The script preserves exact inputs, queries, provider outcomes, quality counts and run-specific
records for review. At least 20 accepted Security results must be manually classified relevant,
questionable or irrelevant if that many are available. No relevance changes are made from this
classification before reporting the findings. Live measurements and manual review remain pending
until a deployment of this revision is available.
