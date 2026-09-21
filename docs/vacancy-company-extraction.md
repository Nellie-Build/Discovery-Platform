# Vacancy employer (company) extraction

Implemented in `domains/vacancies/src/company.ts`; the run statistics show the source per page as
`pageDiagnostics[].companySource`.

## Root cause of the live wrong values

Two live WBO records had the company `inrichting.` and `je vertaalt de missie en visie van de
organisatie in een strategie en operationele doelen.`. Both came from the plain-text label fallback,
which searched the *whole body text* for the word "organisatie" followed by `:` or `-` and took the
rest of the line: "...kwaliteit van de organisatie-inrichting. Dit zegt..." gave `inrichting.`, and the
competency bullet "Aansturen organisatie: je vertaalt..." gave the sentence. The value was never
validated, and that text route was also ranked *above* the DOM label route. The pages did contain the
real employer (an "Over <Employer>" section that repeats the name in the page title).

## Precedence (strongest first; a weaker source never overrides a stronger one)

| companySource | Source |
|---|---|
| `json_ld` | JobPosting `hiringOrganization.name` (used as written) |
| `microdata` | schema.org `itemprop="hiringOrganization"` / `name` (used as written) |
| `explicit_label` | a label element that is exactly "Werkgever", "Organisatie", "Bedrijf", "Employer", "Company", "Hiring organization" followed by its value (dt/dd, th/td, label + sibling, data-* hooks) |
| `organization_block` | `itemprop="employer"`; an element whose class/id says employer/company/organisation *name*; or an "Over/About <Name>" heading whose name is also in the page title and is not the job's location |
| `text_fallback` | "Werkgever: <Name>" / "Organisatie - <Name>" at the start of a line of running text, only if the value looks like an organisation name |
| `page_metadata` | the page's declared owner: `<meta name="author">`, only when a second independent declaration on the page names the same organisation (an image with alt "Logo voor/of <Name>" or "<Name> logo", or `og:site_name`). One declaration alone is never used (an author is often a person). Deliberately the weakest source: it can only fill a company nothing else found. |
| `none` | nothing reliable: company is null |

The word "organisatie" inside a sentence is never evidence. There is no title parsing, no AI, no
site-specific rule.

## Validation

Explicit sources are refused only when obviously not a name: empty, call-to-action/navigation text,
ends with `:`/`?`/`!`, or a whole paragraph. Running text must also look like an organisation: it needs
an uppercase letter or digit, must not start with a lowercase word (except name prefixes such as "de",
"van"), must not contain a sentence break, employment terms (€, uur, per week, salaris, ervaring, ...)
or words addressed to the reader (je, wij, onze, ...), and a trailing full stop is only accepted after
an abbreviation ("B.V.", "Inc."). Length in words or a full stop alone never disqualifies a name:
"Ministerie van Defensie", "Dienst Justitiële Inrichtingen", "Company & Partners", "de Bijenkorf",
"TNO", "Bedrijf B.V." stay valid. Normalisation is whitespace only: names are never rewritten.

### Structured "Over <Name>" blocks (source-aware validation)

An "Over/About <Name>" heading that the page title also confirms is delimited, structured evidence, so
it is validated as `structured` rather than as running text: no word limit (only a generous 150
character limit, the longest real names being under 100), and one sentence-final full stop is removed
(`Over Ministerie van Onderwijs, Cultuur en Wetenschap.` gives `Ministerie van Onderwijs, Cultuur en
Wetenschap`), unless it belongs to an abbreviation or legal form (`B.V.`, `N.V.`, `Inc.`, `Ltd.`,
`e.d.`). It must still look like a name: no `:`/`;`/`?`/`!`, no sentence break, no words addressed to the
reader, no employment terms, no call to action. The title comparison uses the cleaned name, after
whitespace collapse, Unicode NFC normalisation, lowercasing and ignoring a full stop before a space or
the end (no fuzzy matching), and stays mandatory. Generic headings ("Over Utrecht", "Over ons", "Over de
functie", "Over arbeidsvoorwaarden", ...) are still refused. The `text_fallback` rules above are
unchanged: a period-terminated or 10+ word value from running text is still rejected.

## Known consequence

A company that fails validation is now null instead of a wrong name. The company counts +1 in the
plausibility score, so a page that only reached the threshold thanks to a wrong company would no longer
be accepted; none of the 50 + 50 live records checked was affected.

## Hosted recruitment pages (page_metadata)

Real vacancy pages of a hosted recruitment system had `company = null`: no JSON-LD, no microdata, no "Werkgever" label
(the metadata table has Dienstverband / Salaris / Uren / Plaats / Contact only), no employer element and no title that names
the organisation. The employer is declared twice in the page head/body, in two independent places: `<meta name="author"
content="Gemeente Katwijk">` and the logo `<img alt="Logo voor Gemeente Katwijk">`. Their agreement is the evidence; either alone
is not (verified: author-only, logo-only and a person as author all stay null). Existing outcomes cannot change, because the
source is consulted last.
