# Companies domain (`domains/companies`)

Branch-, product- and service-oriented B2B company discovery: find companies by what they do, whom they supply and
where they are, without knowing their names. Consumes `@discovery-platform/core` only; the API adapter is
`apps/api/src/domains/companies-adapter.ts`, the Web App module `apps/web/src/domains/companies`.

| File | What it does |
|---|---|
| `vocabulary.ts` | Maintained concepts with Dutch and English terms per kind: industry (what a company **is**), product, service, specialisation, customer sector (whom it **supplies**), role. A value is only ever expanded to the terms of its own concept; a value not listed is used literally. |
| `geography.ts` | The Netherlands: 12 provinces and a list of places with their province. No inference beyond that. Other countries can be added as another `CountryGeography`. |
| `criteria.ts` | Criteria, validation, summary, and `interpretDescription`: a plain-language description into editable criteria, listing every recognised phrase, what was derived (a product's usual branch) and what was not understood. Browser-safe (`@discovery-platform/domain-companies/criteria`), so the Web App shows the same interpretation the server uses. |
| `page-analysis.ts` | One page of a company's own site: activities with context, addresses, service area, general contact channels, a stated KvK number. Crawl ranking for company pages. |
| `profile.ts` | Profile from the pages, and `evaluateCompany`: one `CriterionMatch` per criterion (status, what was found, source URL, source type, quote, note, check date) and an overall status. |
| `identity.ts` | Identity = registrable domain; `updateStoredCompany` merges a later run into a stored company. |
| `search-plan.ts` | Targeted web searches per run (Dutch and English variants, roles, kinds of company, each OR value, AND combined); hosts that are never a company's own site. |
| `sources.ts` | Route A (`search`) and route B (`website`) as DiscoverySources on the shared crawler and search provider. |
| `export.ts` | CSV export of company profiles: no personal data, formula-injection safe. |

## Two routes

- **Route A, `search`**: criteria (or a description, interpreted on the server when no structured criteria are given) become at most `maxQueries` (default 6, max 12) searches via the configured provider (Tavily or Brave). Results on directories, review/comparison sites, social media, job boards, marketplaces, news, government and search/maps hosts are counted and never treated as a company or as evidence. Each remaining domain is a candidate company; the best `maxCompanies` (default 8, capped by the run's target, max 25) are researched: the result page itself plus the site's most informative pages (about, products, services, sectors, projects, locations, contact), `pagesPerCompany` (default 5) each, within the run's time limit. A candidate with too little evidence is counted (`insufficientCount`) but not stored.
- **Route B, `website`**: one company website the user names (a directory or social URL is refused) is read (up to 12 pages) and always stored, whatever it matches.

Robots.txt, the SSRF-safe transport, page/time limits and the crawl engine are the core's. News, job, legal and account pages are never used as evidence. LinkedIn, Google Maps and other platforms are never fetched.

## Evidence and match status

An activity is **strong** when its own site states it specifically (a heading, the page about it, or repeated mentions) and **weak** for a passing mention. A **customer sector** is strong only when the site says the company supplies or serves it ("wij leveren aan ziekenhuizen", or its sector/project pages); the word "ziekenhuis" somewhere on the site is not enough. A role word after "voor/aan/van/met" is someone else's role ("voor installateurs", "samen met groothandels").

Per criterion: **confirmed** = strong evidence on the company's own site; **possible** = weak evidence, or only the search result snippet; **insufficient** = nothing found. Several values of one kind are alternatives by default ("CCTV of toegangscontrole": either product will do); the criteria can require all of them per list (`logic: { products: 'all' }`, "zowel CCTV als toegangscontrole", "CCTV én toegangscontrole"), and then the weakest value counts. Different kinds all apply (product AND customer sector AND region). Overall: confirmed when every kind is confirmed by at least one of its values; insufficient when no subject kind (what the company does) is at least possible; otherwise possible. An exclusion that the site shows strongly removes the company. Public authorities (gemeente, provincie, ministerie, ...) are not companies and are skipped by the search route.

## Stricter evidence

- **Related terms** (`Concept.related`): broader or neighbouring terms ("onderwijshuisvesting", "scholenbouw" and "schoolgebouwen" for school renovation; "software" for business software; "overheid" for municipalities; "gezondheidszorg" for care institutions). A page that only uses these gives a *related* activity: shown as a lead, always weak, at most a possible match with the note that it does not prove the criterion, and never used to expand a search or to interpret a description.
- **Menu is not content**: the navigation, header, footer and side bars (repeated on every page) are separated from a page's own content. A term only in the menu is weak. Strong needs the page's own title or a content heading, its URL slug, or at least two content sentences across the site.
- **Customer sectors**: strong only with a sentence saying the company supplies or serves the sector, or a heading on its sector/project pages.
- **Re-assessment**: when a later run reads the same pages again, the current judgement replaces the stored one (also downwards); evidence on pages not read again is kept.

## Business types

Every profile has `businessTypes`: *zakelijke leverancier* (business wording: zakelijke klanten, excl. btw, offerte aanvragen, dealers, dealer worden, zakelijke leveringsvoorwaarden, service- en onderhoudscontracten, ...), *consumentenwebwinkel* (a shopping cart with prices or product data, or many prices with consumer wording), *fabrikant*, *distributeur*, *groothandel*, *installateur* (an installation service, or a sentence saying it installs a product it offers), *dienstverlener* and *adviesbureau*, each with strength and the signals behind it. A company can be several; a type is not a product (a web shop selling cameras is not a business supplier of camera solutions, a manufacturer is not an installer). `businessTypes` is an optional criterion and a list filter; `excludedBusinessTypes` excludes a type (a clear case is removed, a weak hint stays with a warning). **Web shops are never excluded by default.**

## What a company does with it, and sector evidence

Products, services and specialisations carry `actions`: the sentences on the company's own site that say it supplies, produces, installs, maintains, advises on or develops it, each with its source URL ("eenvoudig zelf te installeren" is a shop's promise, not an installation service). Customer sectors carry a `basis`: **offering** (the company offers products or services for the sector, its sector page), **reference** (a project or case in the sector) or **mention** (only named); a menu item or cookie banner is never evidence. The explanation per company (`explainMatches`) reads e.g. "Bevestigd: levert camerasystemen. Bevestigd: referentieproject bij zorginstellingen. Onbekend: werkgebied Zuid-Holland." No scores or percentages.

## Batches (continuing a search)

A search that finds more candidates than fit in one run (budget, time) stores the not-yet-researched candidates as the run's continuation (`stats.continuation`, at most 100). `POST /projects/:id/runs { continueFromRunId }` starts the next batch: the server reads the earlier run's own request and cursor from the database (the client cannot change criteria or hand in candidates), checks project, module access and that the run was not continued before (409 `already_continued`; of two simultaneous requests only the first continues), and runs a normal bounded run (its own time limit, company budget, dedupe against existing records) **without searching again**. Each batch reports `batch`, `continuesRunId` and how many candidates are still waiting; the Companies form shows "Volgende batch onderzoeken". Other modules are unaffected (an adapter only continues when it returned a continuation).

## Extended processing (background jobs)

`POST /projects/:id/jobs { request, limits }` runs a search as a **job**: batches in the background instead of one long request (202 at once). The user sets hard totals up front: `maxCandidates` (candidate companies researched over all batches, max 100), `batchSize` (max 10), `pagesPerCompany` (max 12) and `maxSearchQueries` (max 12); `maxBatches` follows from them (plus three retries). The first batch is the only one that searches; every next batch researches the candidates the previous one left (its continuation), without new search-provider calls. `GET /jobs/:id` shows progress and the batches (normal runs, so results are visible per finished batch); `POST /jobs/:id/pause|resume|stop`. One unfinished job per project (enforced by a unique index); a job-managed run cannot also be continued by hand (409 `job_managed`) until the job is stopped or finished.

The job row (`discovery_jobs`, migration 011) is the durable state. A worker in the API process (`jobs/job-runner.ts`, off with `DISCOVERY_JOBS_WORKER=0`, `DISCOVERY_JOBS_CONCURRENCY` default 1) claims a due job with a lease (`UPDATE … FOR UPDATE SKIP LOCKED`), so two workers never run one job. A batch interrupted by a restart is marked failed when its lease expires and the job continues from the last finished batch: no candidate is lost and no record is stored twice. An interrupted or failed **first** batch is not repeated automatically (that would search, and spend credits, again): the job pauses or fails and the user decides. A failing follow-up batch is retried at most three times. Every batch checks again that the project exists, the module is enabled for its workspace and the user who started the job is still a member. Nothing creates a job except that explicit request; there is no scheduling or monitoring.

## CSV export

`POST /projects/:id/export { recordIds? }` (the Companies list offers "filtered" and "all" explicitly) returns a CSV of the project's companies: name, website, how well it is substantiated with the explanation, types, activities, customer sectors with their basis, establishments, service area, contact page, stated KvK number (marked not verified) and check date. Same authentication and workspace isolation as the records; listed ids of other projects are ignored; at most 5000 rows. No e-mail addresses, phone numbers or persons. Every cell is quoted and a cell starting like a formula is prefixed with an apostrophe.

## Geography

A location keeps the place **as written** (`city`, e.g. "Vierpolders"), its **municipality** ("Voorne aan Zee"), province and country, and whether it is a **visiting** or **postal** address. A postal address (Postbus) is not an establishment: it confirms a province or place only as possible. Contact details, postal addresses and project pages are never read as a service area. A place criterion matches the place as written or its municipality. A place of establishment is an address the company publishes (structured data or its contact/about/home pages); a project or reference address is never one. The service area comes from explicit statements ("werkgebied", "landelijk", "actief in ..."). A province criterion is confirmed by an establishment in that province or an explicit service area there; a national service area is only possible; a .nl domain is never evidence. A place criterion is confirmed by an establishment or explicit service area in that place; the same province or a national area is only possible.

## Identity, updates, missing data

Identity is the registrable web domain, never the name: two companies with one name stay two; branches on one domain are one company with several locations; group companies on separate domains stay separate. A KvK number a site states is kept as `statedKvkNumber`; `kvkNumber` is only for a number verified against the registry, which this version has no source for, so it is always null and registration numbers never merge companies.

A later run updates a company only when it found something new: activities, locations, service areas and sources are unions (evidence is never dropped because a page changed), a changed single value keeps the previous one in `changes`, and a value not found again is kept. Runs report new, updated and unchanged; an unchanged company's run snapshot still shows that run's evaluation. Unknown values stay null or empty. Only general business contact channels are stored (role mailboxes such as info@, landline numbers); personal addresses and mobile numbers of people are not.

## Not in this version

No registry source (KvK APIs are paid), no OpenStreetMap/Overpass (ODbL share-alike on derived data and the public Overpass fair-use policy make it unsuitable for a growing company database; OSM also rarely records what a company supplies), no LLM interpretation (the `CompanySearchCriteria` shape is ready for one), no links to Vacancies or Tenders, no scoring of companies, no persons or personal contact data.

## Module access

Migration `010_companies_module.sql` describes the module and leaves the global switch off; it is not in any package (Compleet stays Vacancies + Tenders). An admin enables it globally and grants it per workspace (Admin > Workspaces, or the Maatwerk package). The server-side gate refuses project creation and run starts elsewhere (`module_not_enabled_for_workspace`); existing company records stay readable when access is removed.

## Acceptance (2026-09-25, local, Tavily, 2 queries / at most 5 companies / 4 pages per company per search)

| Search | Results | Skipped (not a company site) | Candidates | Researched | Not researched (budget) | Could not be read | Stored | Confirmed / possible |
|---|---|---|---|---|---|---|---|---|
| Zorgorganisaties in Den Haag | 20 | 3 directories | 11 | 5 | 4 | 2 (crawl-delay beyond the time limit; robots.txt unreadable) | 5 | 3 / 2 |
| NL-bedrijven die CCTV- of toegangscontrolesystemen leveren | 20 | 0 | 16 | 5 | 11 | 0 | 5 | 3 / 2 |
| Bouwbedrijven gespecialiseerd in renovatie van scholen | 20 | 1 social | 17 | 5 | 12 | 0 | 5 | 2 / 3 |
| Beveiligingsbedrijven in Zuid-Holland die camerabewaking installeren voor zorginstellingen | 20 | 1 job site | 15 | 5 | 10 | 0 | 5 | 0 / 5 |

Confirmed/possible are the stored profiles evaluated with the final rules (values of one kind as alternatives). Manually checked against the sites: Eykenburg and Oldael (care organisations in Den Haag), De Koning Bouwgroep (lists "schoolrenovatie" as a service), Van Klompenburg Beveiliging (installs camera security, established in Elburg, so not confirmed for Zuid-Holland). Quadraat is confirmed via "onderwijshuisvesting", which is broader than school renovation. The combined search found no company with every criterion confirmed; nothing was forced. The acceptance also found (and fixed, with tests) text of adjacent elements running together in addresses, page words read as place names, "zorgen" in cookie banners read as care, a municipality presented as a care organisation and a stored misread address never being corrected.
