import type { CheerioAPI } from 'cheerio';
import { websiteScope, type CrawlPage } from '@discovery-platform/core';

/** A cheerio-wrapped node selection — `cheerio` itself doesn't export this as a bare type, and
 * this package's own dependency boundary (see tests/dependency-boundary.test.mjs) never imports
 * `domhandler` directly to get at it, so it is derived from `CheerioAPI`'s own return type. */
type CheerioSelection = ReturnType<CheerioAPI>;

/** Only explicit source facts — a field stays `null` rather than being guessed. No AI, no
 * inference beyond "this exact structured field, label or contact pattern was actually there". */
export interface VacancyFacts {
  title: string | null;
  company: string | null;
  location: string | null;
  salary: string | null;
  hours: string | null;
  contractType: string | null;
  description: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  /** ISO 8601 date (YYYY-MM-DD), only ever taken from an explicit structured source — JobPosting
   * JSON-LD's own `datePosted`, a job-board provider's own reported posting date, or an explicit
   * page date attribute (see extractPostedDate below). Never guessed or inferred from prose —
   * absent when the source doesn't report one. */
  postedDate: string | null;
  sourceUrl: string;
}

function object(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function array(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}
/** The first array entry (or the bare value) that is actually an object — schema.org properties
 * like `hiringOrganization`/`jobLocation` are documented as single-or-array-of values. */
function firstObject(v: unknown): Record<string, unknown> {
  for (const entry of array(v)) { const o = object(entry); if (Object.keys(o).length) return o; }
  return {};
}
function text(v: unknown, max = 500): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
}
function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function dedupeJoin(parts: (string | null)[], sep: string): string | null {
  const seen = [...new Set(parts.filter((v): v is string => Boolean(v)))];
  return seen.length ? seen.join(sep) : null;
}

/**
 * Plain-text, label-based extraction ("Locatie: Amsterdam", "Salaris: €2.800 - €3.400 per
 * maand") — the exact `(text: string) => Partial<TFacts>` shape @discovery-platform/core's
 * `DomainConfig.extractText` already documents (see packages/discovery-core/src/
 * domain-config.ts). Every pattern requires an explicit label immediately before the value —
 * never a bare number/word picked up from unrelated surrounding text.
 */
function afterLabel(text_: string, labels: string[], maxLen = 120): string | null {
  for (const label of labels) {
    const match = new RegExp(`\\b${label}\\b\\s*[:\\-]\\s*([^\\n\\r]{1,${maxLen}})`, 'i').exec(text_);
    if (!match) continue;
    // Stop at the first sentence break or a run of 2+ spaces (the start of unrelated layout
    // text), never the full rest of the line.
    const value = match[1].split(/[.;]\s|\s{2,}/)[0].trim();
    if (value) return value;
  }
  return null;
}

/** Field labels recognized in plain running text ("Label: value" on one line), as a standalone
 * DOM label element paired with a neighboring value element (dt/dd, th/td, a strong/bold/span/
 * etc. tag followed by its sibling), and as an accessible-name attribute (aria-label/title) on an
 * icon element paired with its sibling value. Dutch and English variants only — never a bare word
 * without an explicit label role next to it. */
const LABEL_GROUPS: Record<'location' | 'salary' | 'hours' | 'contractType' | 'contactPerson' | 'company', string[]> = {
  location: ['locatie', 'location', 'standplaats', 'werklocatie'],
  salary: ['salaris', 'salary', 'salarisindicatie'],
  hours: ['uren', 'werkuren', 'hours', 'aantal uur', 'uren per week'],
  contractType: ['contractsoort', 'contract type', 'contracttype', 'dienstverband', 'arbeidsovereenkomst'],
  contactPerson: ['contactpersoon', 'contact person'],
  company: ['werkgever', 'organisatie', 'employer', 'company'],
};

/** Generic `data-*` attribute names a machine-readable metadata hook might use to name its own
 * field — never one site's own bespoke attribute, only the handful of conventional names widely
 * used for this purpose (component/test/analytics hooks). */
const DATA_LABEL_ATTRS = ['data-field', 'data-type', 'data-label', 'data-name', 'data-testid', 'data-meta'];
const DATA_LABEL_SELECTOR = DATA_LABEL_ATTRS.map(attr => `[${attr}]`).join(', ');

export function extractVacancyText(pageText: string): Partial<VacancyFacts> {
  const facts: Partial<VacancyFacts> = {};
  for (const [field, labels] of Object.entries(LABEL_GROUPS) as [keyof typeof LABEL_GROUPS, string[]][]) {
    const value = afterLabel(pageText, labels);
    if (value) facts[field] = value;
  }
  return facts;
}

/** The exact `(facts: Partial<TFacts>) => Partial<TFacts>` shape `DomainConfig.normalize`
 * documents — collapses whitespace and drops anything that normalized down to empty. */
export function normalizeVacancyFacts(facts: Partial<VacancyFacts>): Partial<VacancyFacts> {
  const cleaned: Partial<VacancyFacts> = {};
  for (const [key, value] of Object.entries(facts) as [keyof VacancyFacts, unknown][]) {
    if (typeof value !== 'string') continue;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed) (cleaned as Record<string, string>)[key] = trimmed;
  }
  return cleaned;
}

/** A label word matches only when it is the *entire* trimmed text (or accessible-name attribute)
 * of a DOM element (minus a trailing colon) — never a substring of a longer sentence, so this
 * never fires on running body copy that merely mentions "locatie" in passing. */
function matchLabelElement(labelText: string): keyof typeof LABEL_GROUPS | null {
  const norm = labelText.trim().replace(/[:：]\s*$/, '').trim().toLowerCase();
  if (!norm || norm.length > 40) return null;
  for (const [field, labels] of Object.entries(LABEL_GROUPS) as [keyof typeof LABEL_GROUPS, string[]][]) {
    if (labels.includes(norm)) return field;
  }
  return null;
}

/**
 * Generic semantic DOM label/value extraction — no site-specific selectors, only structural HTML
 * patterns any vacancy site might reasonably use: definition lists (dt/dd), tables (th/td within
 * one row), a label element (strong/b/span/div/p/li/label) immediately followed by its value, and
 * an accessible-name attribute (aria-label or title — the standard way an icon-only element gives
 * itself a text label) immediately followed by its value. Only fires when the label text/
 * attribute is *exactly* one of the known label words; the paired value is always read from the
 * very next node in the same parent, never guessed from surrounding content.
 */
function extractLabelValueDom($: CheerioAPI): Partial<VacancyFacts> {
  const facts: Partial<VacancyFacts> = {};
  const setOnce = (field: keyof typeof LABEL_GROUPS, raw: string | null | undefined) => {
    if (field in facts) return;
    const value = text((raw ?? '').replace(/^[\s:：\-–]+/, ''), 200);
    if (value) facts[field] = value;
  };
  // The next node, in DOM order within the same parent, that actually carries text — skipping
  // purely-whitespace text nodes (common formatting between a label and its value, e.g.
  // "<span>Locatie</span> <span>Amsterdam</span>") — still always the *next* real content, never
  // a further search.
  function nextValue<T>(el: T): string | null {
    const siblings = $(el as never).parent().contents().toArray();
    const idx = siblings.indexOf(el as never);
    if (idx < 0) return null;
    for (let j = idx + 1; j < siblings.length; j++) {
      const node = siblings[j];
      const raw = node.type === 'text' ? (node as unknown as { data: string }).data : $(node).text();
      if (raw.trim()) return raw;
    }
    return null;
  }

  $('dt').slice(0, 300).each((_i, el) => {
    const field = matchLabelElement($(el).text());
    if (field) setOnce(field, $(el).next('dd').text());
  });

  $('tr').slice(0, 300).each((_i, row) => {
    const th = $(row).children('th').first();
    if (!th.length) return;
    const field = matchLabelElement(th.text());
    if (field) setOnce(field, $(row).children('td').first().text());
  });

  $('strong, b, span, div, p, li, label').slice(0, 500).each((_i, el) => {
    const field = matchLabelElement($(el).text());
    if (field) setOnce(field, nextValue(el));
  });

  // A label can also live purely in an accessible-name attribute on an otherwise empty icon
  // element (e.g. role="img" title="Locatie" aria-label="Locatie") — a standard, generic
  // accessibility pattern for icon-led metadata, not any one site's own markup convention.
  $('[aria-label], [title]').slice(0, 500).each((_i, el) => {
    const $el = $(el);
    const field = matchLabelElement($el.attr('aria-label') ?? '') ?? matchLabelElement($el.attr('title') ?? '');
    if (field) setOnce(field, nextValue(el));
  });

  // A label can also live in a plain `data-*` attribute naming the field, with the value as that
  // same element's own text — e.g. `<span data-field="location">Hengelo</span>`, a common
  // machine-readable hook modern "vacancy widget" components emit for their own client-side
  // filtering/search (never a next-sibling pattern here, since label and value are one element).
  // Generic across any site using this convention — never one site's own attribute name/class.
  $(DATA_LABEL_SELECTOR).slice(0, 500).each((_i, el) => {
    const $el = $(el);
    let field: keyof typeof LABEL_GROUPS | null = null;
    for (const attr of DATA_LABEL_ATTRS) {
      field = matchLabelElement($el.attr(attr) ?? '');
      if (field) break;
    }
    if (field) setOnce(field, $el.text());
  });

  return facts;
}

/**
 * schema.org microdata (itemprop attributes) for the fields JSON-LD may not have covered —
 * company and location only, each requiring the same explicit nested property JSON-LD would (a
 * hiringOrganization's own `name`, a jobLocation's own address parts), never a bare, unscoped
 * `itemprop="name"` anywhere on the page. That property is reused by virtually every schema.org
 * type (Organization, WebSite, Person, ...), so trusting it outside an explicit
 * hiringOrganization scope is exactly how a site's own header/logo heading
 * (`<h1 itemprop="name">Site Name</h1>`) could get mistaken for a job's employer — it is only
 * ever read here nested inside `[itemprop="hiringOrganization"]`.
 */
function extractMicrodata($: CheerioAPI): Partial<VacancyFacts> {
  const facts: Partial<VacancyFacts> = {};

  const company = text($('[itemprop="hiringOrganization"] [itemprop="name"]').first().text(), 200);
  if (company) facts.company = company;

  // Prefer address parts nested inside an explicit jobLocation scope; fall back to the same
  // address itemprops anywhere on the page for sites that mark up the address without the
  // enclosing Place/jobLocation wrapper. Either way, only ever the explicit itemprop values.
  const jobLocation = $('[itemprop="jobLocation"]').first();
  const within = (prop: string) => (jobLocation.length ? jobLocation.find(`[itemprop="${prop}"]`) : $(`[itemprop="${prop}"]`)).first();
  const location = dedupeJoin(
    [text(within('streetAddress').text(), 200), text(within('addressLocality').text(), 200), text(within('addressRegion').text(), 200)],
    ', ',
  );
  if (location) facts.location = location;

  return facts;
}

// A bare value's own *shape* can identify its field without any label at all — "40 uur" only
// ever means hours, regardless of what site it came from; "Fulltime"/"Parttime" (and their Dutch
// equivalents) are a small, universal, closed employment-type vocabulary, not any one site's own
// wording. Never used for `location` or `salary` — recognizing an arbitrary bare word as a place
// name, or a bare number as money, would mean inventing geography/currency knowledge this package
// deliberately has none of (see docs/architecture.md).
const HOURS_VALUE_SHAPE = /^\d{1,3}(?:[.,]\d{1,2})?\s*-?\s*\d{0,3}\s*(?:uur|u|hours?|hrs?)(?:\s*\/?\s*(?:per\s*)?(?:week|wk))?$/i;
const CONTRACT_TYPE_VALUES = new Set(['fulltime', 'full-time', 'full time', 'parttime', 'part-time', 'part time', 'voltijd', 'deeltijd']);

function matchValueShape(value: string): 'hours' | 'contractType' | null {
  const trimmed = value.trim();
  if (HOURS_VALUE_SHAPE.test(trimmed)) return 'hours';
  if (CONTRACT_TYPE_VALUES.has(trimmed.toLowerCase())) return 'contractType';
  return null;
}

/** A bounded "near the vacancy heading" DOM region — the heading's own parent, plus up to three
 * of that parent's next siblings — where a label-free metadata item (see matchValueShape) is
 * trusted as belonging to *this* vacancy. The same bare value found elsewhere on the page (e.g.
 * mentioned in passing within running body copy) is not — nothing marks it as this vacancy's own
 * metadata there. Never a site-specific selector, only DOM proximity to whichever heading
 * resolveDomTitle already chose. */
function metadataBlockScope($: CheerioAPI, headingEl: CheerioSelection | null): CheerioSelection {
  if (!headingEl || !headingEl.length) return $([]);
  const parent = headingEl.parent();
  if (!parent.length) return $([]);
  const region = [parent];
  let sibling = parent.next();
  for (let i = 0; i < 3 && sibling.length; i++) {
    region.push(sibling);
    sibling = sibling.next();
  }
  return $(region.map(node => node.toArray()).flat());
}

/**
 * Generic, label-free vacancy metadata — repeated short "leaf" values (no element children of
 * their own) structurally grouped near the vacancy heading, the classic modern pattern of
 * several short metadata items ("Tender Manager" / "Hengelo" / "40 uur" / "HBO") stacked with no
 * literal "Label: value" text anywhere. Only ever assigns a field when the *value's own shape*
 * unambiguously identifies it (see matchValueShape) — never a positional guess ("the second item
 * must be the location"), since that would risk misreading an unrelated short value (a
 * department, a seniority level, ...) as a place name.
 */
function extractMetadataBlockDom($: CheerioAPI, headingEl: CheerioSelection | null): Partial<VacancyFacts> {
  const facts: Partial<VacancyFacts> = {};
  const scope = metadataBlockScope($, headingEl);
  if (!scope.length) return facts;
  const leaves = scope.find('*').filter((_i, el) => $(el).children().length === 0);
  leaves.slice(0, 100).each((_i, el) => {
    const value = text($(el).text(), 40);
    if (!value) return;
    const field = matchValueShape(value);
    if (field && !(field in facts)) facts[field] = value;
  });
  return facts;
}

/**
 * A duly semantic, standards-based description block only — schema.org microdata's own
 * `itemprop="description"` hook (the microdata sibling of the JSON-LD `JobPosting.description`
 * property this file already reads above), never a guess at which `<div>` "looks like" the body
 * copy. If a page doesn't mark its description this way, `description` stays `null` rather than
 * capturing the whole page.
 */
function extractDescriptionDom($: CheerioAPI): string | null {
  const el = $('[itemprop="description"]').first();
  if (!el.length) return null;
  const html = el.html();
  if (!html) return null;
  const value = stripHtml(html);
  return value.length > 40 ? value.slice(0, 10_000) : null;
}

// Clearly-irrelevant regions — navigation, footer, forms, cookie notices, and "related/relevant/
// similar vacancies" widgets (a real vacancy detail page very commonly ends with a "you might
// also like" section previewing a few *other* jobs; that section is not this page's own subject).
// Used to strip these out of a description fallback (below) and to keep them from ever counting
// as evidence that the page itself is an overview (see looksLikeOverviewPage). Generic structural
// tags plus a handful of universal, purpose-describing class/id substrings — never one site's own
// class name.
const NON_CONTENT_SELECTOR =
  'nav, footer, header, form, script, style, noscript, ' +
  '[class*="cookie" i], [id*="cookie" i], [class*="menu" i], ' +
  '[class*="related" i], [class*="similar" i], [class*="relevant" i]';
const DESCRIPTION_FALLBACK_MIN_LENGTH = 150;

/**
 * A generic DOM description fallback for pages with real body copy but no `itemprop="description"`
 * marker — modern practice for many "werken-bij" sites. Scoped to a semantic `<main>` or
 * `<article>` element only (never a bare guess across the whole `<body>`, which would just as
 * easily capture navigation and unrelated page chrome on a page with no such container); within
 * that scope, known non-content regions are stripped first. Requires a substantial result
 * (`DESCRIPTION_FALLBACK_MIN_LENGTH`) — a short leftover fragment is not "the description", it is
 * simply not confidently found here and stays `null`.
 */
/**
 * Only text from `<p>` elements counts — never every remaining word inside `<main>`/`<article>`
 * after excluding a fixed list of chrome selectors, which real production content proved too
 * permissive: a vacancy *overview* page's own filter/facet sidebar (many short `<label>`/`<li>`
 * checkbox options, e.g. "Vakgebied", "ICT", "Wo", "Hbo", ...) lives right inside `<main>` too and
 * is not excluded by any generic chrome selector, but is never wrapped in `<p>` tags the way real
 * authored prose almost always is — restricting to `<p>` text is what keeps that sidebar out
 * without hardcoding anything about this one site's own filter widget.
 */
function extractDescriptionDomFallback($: CheerioAPI): string | null {
  const scope = $('main, article').first();
  if (!scope.length) return null;
  const clone = scope.clone();
  clone.find(NON_CONTENT_SELECTOR).remove();
  // An application call-to-action link ("Solliciteer nu") is not part of the job's own text —
  // strip it the same way a whole application *form* is already excluded above.
  clone.find('a').filter((_i, el) => /solliciteer|apply|bekijk\s*vacature/i.test(text($(el).text(), 100) ?? '')).remove();
  const paragraphs = clone.find('p').toArray()
    .map(el => text($(el).text(), 2000))
    .filter((v): v is string => Boolean(v));
  const value = paragraphs.join(' ');
  return value.length >= DESCRIPTION_FALLBACK_MIN_LENGTH ? value.slice(0, 10_000) : null;
}

/**
 * A heading (an explicit itemprop="title" element, or a bare <h1>) is "generic" when it merely
 * repeats the site's own brand/name rather than saying anything about this specific page —
 * checked only against explicit, standards-based signals the page itself declares, never a
 * hardcoded site name: the Open Graph `og:site_name` meta tag, and any delimiter-separated
 * segment of the page's own <title> tag (the conventional "page-specific part - Site Name"
 * shape). This is exactly what a bare first <h1> can get wrong: a real vacancy page's site-wide
 * header/logo heading is structurally indistinguishable from its actual content heading without
 * a check like this one.
 */
function isGenericHeading($: CheerioAPI, candidate: string): boolean {
  const norm = candidate.trim().toLowerCase();
  if (!norm) return true;
  const siteName = text($('meta[property="og:site_name"]').first().attr('content'));
  if (siteName && siteName.trim().toLowerCase() === norm) return true;
  const titleTagText = text($('title').first().text());
  if (titleTagText) {
    const segments = titleTagText.split(/\s*[-|•–—:]\s*/).map(s => s.trim().toLowerCase()).filter(Boolean);
    // Only a genuine *segment* of a multi-part title counts — if the whole title has no
    // delimiter, comparing against "the entire title" would wrongly flag a page whose <h1>
    // simply, legitimately matches its <title> in full.
    if (segments.length > 1 && segments.includes(norm)) return true;
  }
  return false;
}

/**
 * DOM title resolution, used only when there is no JobPosting JSON-LD title (the most trusted
 * source, handled by the caller). In order: (B) an explicit, standards-based DOM title marker —
 * schema.org's own `itemprop="title"` property in microdata form — as long as it doesn't itself
 * look like a generic/site-wide heading; (C) the page's own <title> tag, taken as-is even with
 * extra site-suffix noise, since it is nearly always authored per page; (D) the first <h1> that
 * is not a generic/site-wide heading, used only as an absolute last resort — a bare first <h1>
 * proved unreliable in production (a site-wide header/logo heading was picked up as the job
 * title), so it never outranks the page's own <title>.
 */
interface ResolvedDomTitle {
  text: string | null;
  /** The heading element the title text actually came from (or, failing that, the first
   * non-generic `<h1>` if any exists) — used only as an anchor for `extractMetadataBlockDom`'s
   * "near the heading" scope, never for the title text itself once a better source outranks it. */
  el: CheerioSelection | null;
}

function firstNonGenericH1($: CheerioAPI): CheerioSelection | null {
  for (const el of $('h1').toArray()) {
    const candidate = text($(el).text());
    if (candidate && !isGenericHeading($, candidate)) return $(el);
  }
  return null;
}

function resolveDomTitle($: CheerioAPI): ResolvedDomTitle {
  const semanticEl = $('[itemprop="title"]').first();
  const semantic = text(semanticEl.text());
  if (semantic && !isGenericHeading($, semantic)) return { text: semantic, el: semanticEl };

  const titleTag = text($('title').first().text());
  if (titleTag) return { text: titleTag, el: firstNonGenericH1($) };

  const h1 = firstNonGenericH1($);
  if (h1) return { text: text(h1.text()), el: h1 };
  return { text: null, el: null };
}

/**
 * schema.org JobPosting structured data — the same @graph-walking approach discovery/src/
 * extractors/accommodation.ts already uses for its own Accommodation/Hotel/VacationRental
 * types, applied to a completely different @type. Structured data always outranks the
 * text-label fallback above for any field it actually supplies. Tolerant of the schema.org
 * variations real sites actually emit: `@type` as a string or array, JobPosting nested inside
 * `@graph`, `hiringOrganization`/`jobLocation` as a single object or an array of them, and
 * `employmentType` as a string or array.
 */
export function extractJobPostingJsonLd($: CheerioAPI): Partial<VacancyFacts>[] {
  const nodes: Record<string, unknown>[] = [];
  function visit(v: unknown, depth = 0) {
    if (depth > 10 || nodes.length > 200) return;
    if (Array.isArray(v)) { v.slice(0, 200).forEach(x => visit(x, depth + 1)); return; }
    const n = object(v);
    if (!Object.keys(n).length) return;
    nodes.push(n);
    if (n['@graph']) visit(n['@graph'], depth + 1);
  }
  $('script[type="application/ld+json"]').slice(0, 30).each((_i, el) => {
    const raw = $(el).text();
    if (raw.length > 200_000) return;
    try { visit(JSON.parse(raw)); } catch { /* Invalid structured data is not evidence. */ }
  });

  return nodes.filter(n => array(n['@type']).includes('JobPosting')).map(n => {
    const facts: Partial<VacancyFacts> = {};
    const title = text(n.title); if (title) facts.title = title;
    const company = text(firstObject(n.hiringOrganization).name); if (company) facts.company = company;

    const locationParts = array(n.jobLocation).map(loc => {
      const address = object(object(loc).address);
      return dedupeJoin([text(address.streetAddress), text(address.addressLocality), text(address.addressRegion)], ', ');
    });
    const location = dedupeJoin(locationParts, '; ');
    if (location) facts.location = location;

    const salaryObj = object(n.baseSalary);
    const salaryValue = object(salaryObj.value);
    const amount = typeof salaryValue.value === 'number' ? String(salaryValue.value)
      : typeof salaryValue.minValue === 'number' && typeof salaryValue.maxValue === 'number' ? `${salaryValue.minValue}-${salaryValue.maxValue}`
      : null;
    if (amount) facts.salary = [text(salaryObj.currency), amount, text(salaryValue.unitText)].filter(Boolean).join(' ');

    const employmentTypes = [...new Set(array(n.employmentType).map(t => text(t)).filter((v): v is string => Boolean(v)))];
    if (employmentTypes.length) facts.contractType = employmentTypes.join(', ');

    const description = text(n.description, 10_000);
    if (description) facts.description = stripHtml(description);

    const postedDate = normalizeIsoDate(typeof n.datePosted === 'string' ? n.datePosted : null);
    if (postedDate) facts.postedDate = postedDate;

    return facts;
  });
}

/** Accepts only an explicit, unambiguous calendar date — `YYYY-MM-DD`, or the date portion of a
 * full ISO 8601 timestamp (`YYYY-MM-DDTHH:mm:ss...`). Never a relative phrase ("3 dagen geleden"),
 * never a locale-specific format (`DD-MM-YYYY` is ambiguous with `MM-DD-YYYY`) — those would
 * require guessing a convention this package has no business assuming. */
function normalizeIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return `${year}-${month}-${day}`;
}

/**
 * A generic, explicit-only DOM fallback for a posting date, used only when there is no JobPosting
 * JSON-LD — schema.org microdata's own `itemprop="datePosted"` (on a `<meta content>` or a `<time
 * datetime>` element), or a bare `<time datetime="...">` element. Both are standard, structural
 * HTML/schema.org conventions, never a site-specific selector.
 */
function extractPostedDateDom($: CheerioAPI): string | null {
  const metaScoped = $('[itemprop="datePosted"]').first();
  if (metaScoped.length) {
    const value = normalizeIsoDate(metaScoped.attr('content') ?? metaScoped.attr('datetime') ?? text(metaScoped.text()));
    if (value) return value;
  }
  const time = $('time[datetime]').first();
  if (time.length) {
    const value = normalizeIsoDate(time.attr('datetime'));
    if (value) return value;
  }
  return null;
}

/** Require separate local teasers pointing to at least two distinct detail pages.
 * Metadata or CTA text alone never establishes a teaser. Related widgets stay excluded.
 * This is DOM analysis only; URL normalization reuses the crawler's existing policy.
 */
function looksLikeOverviewPage($: CheerioAPI, currentUrl: string): boolean {
  let scope: ReturnType<typeof websiteScope>;
  try { scope = websiteScope(currentUrl); } catch { return false; }
  const current = new URL(scope.requestedPage);
  const identity = (url: URL) => `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  const detailUrls = new Set<string>();
  const headings = $('h2, h3, h4').toArray()
    .filter(el => $(el).closest(NON_CONTENT_SELECTOR).length === 0);
  for (const el of headings) {
    const heading = $(el);
    if (!text(heading.text(), 200)) continue;
    // Only the heading's immediate wrapper (or one extra wrapper for a linked title).
    // Never scan a shared section containing multiple headings as if each were a card.
    let container = heading.parent();
    if (container.is('a')) container = container.parent();
    const local = !container.is('body, main, html') && container.find('h2, h3, h4').length === 1;
    const anchors = heading.closest('a[href]').toArray().concat(heading.find('a[href]').toArray(),
      local ? container.find('a[href]').toArray() : []);
    for (const node of anchors) {
      const anchor = $(node);
      if (anchor.closest(NON_CONTENT_SELECTOR).length) continue;
      const href = anchor.attr('href')?.trim();
      if (!href || href.startsWith('#')) continue;
      const normalized = scope.normalize(href, currentUrl);
      if (!normalized) continue;
      const url = new URL(normalized);
      if (url.origin !== current.origin || identity(url) === identity(current)) continue;
      // Navigation, background information and application endpoints are not job details.
      if (/(?:^|\/)(?:home|contact|contact-us|about|about-us|over-ons|organisatie|privacy|login|apply|application|solliciteren|solliciteer|arbeidsvoorwaarden|benefits|pensioen|opleiding)(?:\/|\.[a-z]+$|$)/i.test(url.pathname)) continue;
      const parts = url.pathname.split('/').filter(Boolean);
      const vacancyPath = /^(?:vacatures?|jobs?|careers?|positions?|opportunities)$/i;
      if (!parts.length || vacancyPath.test(parts.at(-1)!)) continue;
      const linkedTitle = anchor.is(heading.closest('a')[0]) || heading.find('a').toArray().some(link => link === node);
      const detailPath = parts.slice(0, -1).some(part => vacancyPath.test(part));
      // An unlinked section heading needs a detail-shaped destination; generic "more info"
      // plus metadata is still insufficient. Linked titles also support opaque job URLs.
      if (!linkedTitle && !detailPath) continue;
      detailUrls.add(identity(url));
      break; // One heading is at most one teaser, even when it has several links.
    }
    if (detailUrls.size >= 2) return true;
  }
  return false;
}

/** Per-page extraction diagnostics — deliberately just counts/booleans/a reason code, never the
 * page's own HTML or any personal data (see extract-vacancy's own doc comments on this file never
 * logging more than it needs to). Used by apps/api's website-mode run stats (see
 * vacancies-adapter.ts) to make it observable *why* a crawled page did or didn't become a record. */
export interface VacancyPageDiagnostic {
  url: string;
  titleFound: boolean;
  metadataFieldsFound: number;
  descriptionFound: boolean;
  directContactFound: boolean;
  signalScore: number;
  accepted: boolean;
  rejectionReason: 'no_title' | 'insufficient_signals' | 'overview_page' | 'insufficient_description' | null;
}

const PLAUSIBILITY_ACCEPT_THRESHOLD = 3;

/**
 * Evidence-based vacancy-detail classifier — replaces the old flat "≥2 groups, title never
 * counts" rule with a weighted combination of STRONG and SUPPORTING signals (see the brief this
 * shipped with). Only reached when there is no JobPosting JSON-LD (structured data is definitive
 * on its own — see extractVacancy). `looksLikeOverviewPage` is checked first and unconditionally
 * rejects: no combination of other evidence overrides "this page previews several different
 * vacancies", since that is a direct, structural sign the page's own subject is *not* one job.
 *
 * Weights: a meaningful, non-generic title (1), a named employer (1), a detail metadata block —
 * up to 2 of location/salary/hours/contractType, capped at 2 points so a single bare item never
 * outweighs everything else (max 2), a substantial description ≥150 chars (2, "strong"), a direct
 * contact — contactPerson/phone/email (2, "strong"), an application call-to-action (1). Accepting
 * at a score of 3 means e.g. title + a named employer + one metadata item passes, but a title with
 * only one bare metadata item (score 2) does not — the exact "Onderzoeker" + "Locatie: Nijmegen"
 * case this rule exists to keep rejecting.
 *
 * One extra guard on top of the raw score: `title + direct contact` alone (with zero employment
 * metadata and no description) is never enough, even though that combination alone already
 * reaches the threshold — a real production false positive (a company's own `/contact` staff
 * page: a page title, plus a named employee's own phone/e-mail, but nothing else job-specific at
 * all). A genuine vacancy detail page always has *some* job-specific evidence beyond "there is a
 * person to contact" — at least one metadata field or a real description.
 */
function scoreVacancyDetailEvidence($: CheerioAPI, r: VacancyFacts): { score: number; metadataFieldsFound: number; directContactFound: boolean; descriptionFound: boolean } {
  let score = 0;
  if (r.title && !isGenericHeading($, r.title)) score += 1;
  if (r.company) score += 1;
  const metadataFieldsFound = [r.location, r.salary, r.hours, r.contractType].filter(Boolean).length;
  score += Math.min(2, metadataFieldsFound);
  const descriptionFound = Boolean(r.description && r.description.length >= DESCRIPTION_FALLBACK_MIN_LENGTH);
  if (descriptionFound) score += 2;
  const directContactFound = Boolean(r.contactPerson || r.phone || r.email);
  if (directContactFound) score += 2;
  const hasApplyCta = $('a, button').toArray()
    .some(el => /solliciteer|apply|bekijk\s*vacature/i.test(text($(el).text(), 100) ?? ''));
  if (hasApplyCta) score += 1;
  return { score, metadataFieldsFound, directContactFound, descriptionFound };
}

function diagnose($: CheerioAPI, url: string, r: VacancyFacts, hasJsonLd: boolean): VacancyPageDiagnostic {
  const titleFound = Boolean(r.title);
  if (hasJsonLd) {
    const { metadataFieldsFound, directContactFound, descriptionFound } = scoreVacancyDetailEvidence($, r);
    return { url, titleFound, metadataFieldsFound, descriptionFound, directContactFound, signalScore: PLAUSIBILITY_ACCEPT_THRESHOLD, accepted: true, rejectionReason: null };
  }
  if (looksLikeOverviewPage($, url)) {
    return { url, titleFound, metadataFieldsFound: 0, descriptionFound: false, directContactFound: false, signalScore: 0, accepted: false, rejectionReason: 'overview_page' };
  }
  const { score, metadataFieldsFound, directContactFound, descriptionFound } = scoreVacancyDetailEvidence($, r);
  // A single "soft" signal (just a description, or just someone to contact) is never enough on
  // its own — a real production false positive on a /contact page proved a substantial paragraph
  // alone (a web form's own instructions, title + description, no actual metadata or contact
  // info) already reached the raw score threshold. Either a real employment-metadata field
  // (location/salary/hours/contractType — virtually every genuine vacancy states at least one),
  // or the exact "title + description + contact" combination the brief this shipped with names
  // explicitly, is required — never description alone, never contact alone.
  const hasJobSpecificEvidence = metadataFieldsFound > 0 || (descriptionFound && directContactFound);
  const accepted = score >= PLAUSIBILITY_ACCEPT_THRESHOLD && hasJobSpecificEvidence;
  let rejectionReason: VacancyPageDiagnostic['rejectionReason'] = null;
  if (!accepted) rejectionReason = !titleFound ? 'no_title' : !hasJobSpecificEvidence ? 'insufficient_description' : 'insufficient_signals';
  return { url, titleFound, metadataFieldsFound, descriptionFound, directContactFound, signalScore: score, accepted, rejectionReason };
}

/**
 * One crawled page → zero or more VacancyFacts, plus a diagnostic explaining the (single, primary)
 * acceptance decision for this page — see `extractVacancy` below for the plain, backward-compatible
 * wrapper every existing caller/test uses. Composes, in order of trust: structured JobPosting data
 * (page-level, needs the DOM — never routed through DomainConfig.extractText, since that seam only
 * ever sees plain text, not the DOM), then schema.org microdata, then the plain-text label
 * fallback, then the generic DOM label/value fallback (including data-* hints and label-free
 * value-shape metadata near the heading), then generic contact details discovery-core's own
 * crawler already extracted for this page. Without JobPosting JSON-LD, a page must pass
 * `scoreVacancyDetailEvidence`'s evidence-based threshold — see its own doc comment.
 */
export function extractVacancyWithDiagnostic(page: CrawlPage): { facts: VacancyFacts[] | undefined; diagnostic: VacancyPageDiagnostic } {
  const bodyText = page.$('body').clone().find('script, style, noscript').remove().end().text();
  const textFacts = normalizeVacancyFacts(extractVacancyText(bodyText));
  const domLabelFacts = normalizeVacancyFacts(extractLabelValueDom(page.$));
  const microdata = normalizeVacancyFacts(extractMicrodata(page.$));
  const domTitle = resolveDomTitle(page.$);
  const metadataBlockFacts = normalizeVacancyFacts(extractMetadataBlockDom(page.$, domTitle.el));
  const domDescription = extractDescriptionDom(page.$) ?? extractDescriptionDomFallback(page.$);
  const jsonLdFacts = extractJobPostingJsonLd(page.$);
  const domPostedDate = extractPostedDateDom(page.$);

  function build(structured: Partial<VacancyFacts>): VacancyFacts {
    return {
      title: structured.title ?? domTitle.text ?? null,
      company: structured.company ?? microdata.company ?? textFacts.company ?? domLabelFacts.company ?? null,
      location: structured.location ?? microdata.location ?? textFacts.location ?? domLabelFacts.location ?? null,
      salary: structured.salary ?? textFacts.salary ?? domLabelFacts.salary ?? null,
      hours: textFacts.hours ?? domLabelFacts.hours ?? metadataBlockFacts.hours ?? null,
      contractType: structured.contractType ?? textFacts.contractType ?? domLabelFacts.contractType ?? metadataBlockFacts.contractType ?? null,
      description: structured.description ?? domDescription ?? null,
      contactPerson: textFacts.contactPerson ?? domLabelFacts.contactPerson ?? null,
      phone: page.contacts.phone ?? null,
      email: page.contacts.email ?? null,
      postedDate: structured.postedDate ?? domPostedDate ?? null,
      sourceUrl: page.url,
    };
  }

  const hasJsonLd = jsonLdFacts.length > 0;
  const results = (hasJsonLd ? jsonLdFacts : [{}]).map(build);
  const primary = results[0] ?? build({});
  const diagnostic = diagnose(page.$, page.url, primary, hasJsonLd);

  const plausible = results.filter(r => hasJsonLd || diagnostic.accepted);
  return { facts: plausible.length ? plausible : undefined, diagnostic };
}

/** The plain, backward-compatible entry point every existing caller/test uses — identical
 * behavior to before, just without the diagnostic. See extractVacancyWithDiagnostic above for
 * the one place the actual logic lives. */
export function extractVacancy(page: CrawlPage): VacancyFacts[] | undefined {
  return extractVacancyWithDiagnostic(page).facts;
}
