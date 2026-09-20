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

## Validation

`npm test` passed all 434 tests; `npm run build` and `npm run typecheck` passed. The tests ran
from the NTFS verification copy with the unchanged committed lockfile, because the working
checkout is on exFAT and cannot host npm workspace junctions. An earlier concurrent API/UI test
invocation exhausted local memory; the complete sequential workspace suite passed. CI on
`cab9f98` (typecheck, tests, migration, build) and the deploy workflow both succeeded.

## Live verification (2026-09-20, test service, commit cab9f98)

`scripts/verify-branch-quality.mjs` created an isolated test project ("Security Agencies —
branch verification") in a fresh test account and ran two branch runs with exactly the user
input below: no hidden query expansion, no relevance change afterwards. Raw output was kept
outside the repository.

### Source availability during both runs

| Source | Security run | Onderwijs run |
|---|---|---|
| Indeed | ok, 50 candidates, 0.6 s | ok, 50 candidates, 0.4 s |
| LinkedIn | partial (timeout after ~9.5 s), 18 candidates | partial (timeout after ~9.5 s), 20 candidates |
| Web Search (Brave) | not_configured | not_configured |

Coverage in both runs: 3 sources requested, 2 available, 2 succeeded, 1 failed (LinkedIn,
partial). **Brave Search is not configured on the test environment**, so only Indeed and
LinkedIn contributed. Results therefore mean "found through the available sources", not "all
existing vacancies".

### Security run

Input: branch `Security`, keywords `security officer beveiliging`, region Nederland, Standard,
target 50.

| Measure | Value |
|---|---|
| Query sent to Indeed and LinkedIn | `Security security officer beveiliging` |
| Candidates discovered | 68 (Indeed 50, LinkedIn 18) |
| Relevant / rejected by relevance | 55 / 12 |
| Duplicates within the crawl | 5 |
| Records accepted | 50 (target 50) |
| Run status / stopReason | partial / target_reached |

### Onderwijs run (isolation check)

Input: branch `Onderwijs`, no keywords, region Nederland, Standard, target 50.

| Measure | Value |
|---|---|
| Query sent to Indeed and LinkedIn | `Onderwijs` |
| Candidates discovered | 70 (Indeed 50, LinkedIn 20) |
| Relevant / rejected by relevance | 42 / 28 |
| Duplicates within the crawl | 1 |
| Records accepted | 41 (target not reached) |
| Run status / stopReason | partial / source_unavailable |

Branch isolation held: the two runs share 0 records, no Onderwijs title contains a security
term, and no Security title contains an education term. All 41 Onderwijs records are education
vacancies; the 8 without an education term in title or company (for example "Leerkracht groep 2")
are education roles as well.

### Manual relevance review of the Security results

All 50 accepted Security records were classified by hand from title, company and the start of the
description, against the intent "security officer / beveiliging" (physical and information
security both count). The review did not change any code or relevance rule.

| Classification | First 20 | All 50 |
|---|---|---|
| Relevant | 13 | 36 |
| Questionable | 4 | 8 |
| Irrelevant | 3 | 6 (12%) |

- **Irrelevant:** "IT Werkplek Specialist", two "Facility Officer" (CEVA Logistics), "Driver Desk
  Officer" (DSV) and two "Facilitair Service Coördinator" (TNO). The bare term `officer` or an
  incidental word in the description caused the match.
- **Questionable:** for example "Chief Privacy Officer" and "Compliance Officer" (privacy or
  compliance rather than security), and "Sales Manager / Sales Officer" at Eye Watch Security
  Group, where only the company name matches.

## Known limitations

- **Ambiguous intent.** "security officer" covers both physical security and IT security; the
  query cannot tell which the user means.
- **Relevance noise.** Relevance is any-of over whole words, and a description-only match (or the
  bare word `officer`) is sufficient. This explains the roughly 12% irrelevant Security records.
  Weak contextual matches in descriptions or company names can still be accepted.
- **LinkedIn on the test environment.** Both runs timed out after about 9.5 s and returned only
  18-20 candidates. LinkedIn records carry "Join to apply..." boilerplate in their descriptions.
- **stopReason for a transient failure.** A LinkedIn timeout yields `source_unavailable` (Onderwijs
  run), which is debatable for what is closer to a temporary failure.
- **Web Search not configured.** Brave is not configured (`BRAVE_SEARCH_API_KEY` missing); it is
  shown as "not_configured", and no Brave dependency is made mandatory.
- **Legacy records.** Records created before migration `006_run_records.sql` have no run
  association and are not backfilled; existing historical duplicates are not merged.
- **Unexplained original failure.** The originally reported zero-candidate run could not be
  traced to a specific external cause without its run ID.
- **Scope.** No scheduler, persistent provider cooldown, Crawlee, Playwright, new module or
  crawler engine has been introduced.

The test project and test account created by the verification remain on the test environment.
