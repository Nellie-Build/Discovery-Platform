# Vacancy overview detection

The old detector required two distinct heading texts, then counted each h2/h3/h4 whose immediate parent contained a metadata icon OR a link labelled solliciteer, apply, bekijk vacature or meer informatie. Two counted headings rejected the whole page as `overview_page`. Multiple headings could even share that same parent.

The replacement requires at least two different normalized detail destinations associated with separate headings outside NON_CONTENT_SELECTOR. A destination must either be linked directly to the heading (including an anchor wrapping the card), or occur in its immediate local container with exactly one h2/h3/h4 and have a detail-shaped path below vacatures/vacature/jobs/job/careers/career/positions/position/opportunities/opportunity. Link text is not a positive signal. A linked title can also point to an opaque URL such as /123.

The existing core websiteScope normalization resolves relative links, rejects unsupported protocols, credentials, other hosts and binary resources, removes fragments and tracking parameters, and sorts query parameters. An additional same-origin comparison excludes protocol/port/host changes. Current-page identities and duplicate destinations ignore trailing slashes. Fragment-only links, common navigation/background/application endpoints, and the listing roots themselves do not count. No network access is performed by the detector.

Own salary/hours/contract sections and external background information no longer establish cards. This fixes WBO-shaped details without hostname, employer, heading-text or site-class exceptions. Real listings still contain separate linked teaser destinations. Related widgets remain excluded. Metadata alone is deliberately insufficient.

The heuristic is conservative, not a universal classifier of arbitrary URLs: unlinked headings with opaque sibling destinations are not counted. The existing evidence scores, thresholds, JSON-LD bypass, relevance, dedupe, crawler configuration, queues and ranking are unchanged.

Regression coverage includes metadata-only content sections, external background links, same-page/fragments/tracking links, repeated destinations, related cards, navigation/application links, unsupported protocols, shared multi-heading containers, local detail links with different CTA labels, complete anchor cards, and opaque linked titles. Two historical synthetic listing fixtures now include real detail links: their previous metadata-only markup cannot establish an overview under the new contract.

Both previously TODO WBO engine tests are active. SPIE coverage exercises details, listings, contact/open-application/general pages and a 50-record target for each engine. Validation is local with synthetic transports; no live crawl, push or deployment is part of this change.

Activating the WBO TODO tests also exposed a dormant assertion mismatch: these fixtures provide only a full HTML title, and the unchanged title extractor returns that full title. Expectations now assert those exact titles and three accepted detail pages, without changing title extraction.

Focused validation: 65 tests passed, zero failed/skipped/TODO, including both WBO engine cases and both SPIE 50-record cases.

Final validation: `npm test` passed all 578 tests (core 165, database 20, client 9, vacancies 180, API 124, examples 3, web 77), with no failed/skipped/TODO tests. `npm run build`, `npm run typecheck` and `git diff --check` passed. Commands ran in the existing NTFS verification copy with dependencies installed from this repository's lockfile, because the E: workspace does not support npm workspace junctions.
