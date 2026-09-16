import type { CheerioAPI } from 'cheerio';
import type { CrawlPage } from '@discovery-platform/core';

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
function resolveDomTitle($: CheerioAPI): string | null {
  const semantic = text($('[itemprop="title"]').first().text());
  if (semantic && !isGenericHeading($, semantic)) return semantic;

  const titleTag = text($('title').first().text());
  if (titleTag) return titleTag;

  for (const el of $('h1').toArray()) {
    const candidate = text($(el).text());
    if (candidate && !isGenericHeading($, candidate)) return candidate;
  }
  return null;
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

    return facts;
  });
}

/**
 * One crawled page → zero or more VacancyFacts. Composes, in order of trust: structured
 * JobPosting data (page-level, needs the DOM — never routed through DomainConfig.extractText,
 * since that seam only ever sees plain text, not the DOM), then schema.org microdata, then the
 * plain-text label fallback, then the generic DOM label/value fallback, then generic contact
 * details discovery-core's own crawler already extracted for this page. Without JobPosting
 * JSON-LD, a page needs at least two independent vacancy-specific signal groups to be reported at
 * all — see `isPlausibleVacancyPage` below for why a single group (e.g. just location/salary/
 * hours/contractType) is not enough on its own.
 */
export function extractVacancy(page: CrawlPage): VacancyFacts[] | undefined {
  const bodyText = page.$('body').clone().find('script, style, noscript').remove().end().text();
  const textFacts = normalizeVacancyFacts(extractVacancyText(bodyText));
  const domLabelFacts = normalizeVacancyFacts(extractLabelValueDom(page.$));
  const microdata = normalizeVacancyFacts(extractMicrodata(page.$));
  const domDescription = extractDescriptionDom(page.$);
  const domTitle = resolveDomTitle(page.$);
  const jsonLdFacts = extractJobPostingJsonLd(page.$);

  function build(structured: Partial<VacancyFacts>): VacancyFacts {
    return {
      title: structured.title ?? domTitle ?? null,
      company: structured.company ?? microdata.company ?? textFacts.company ?? domLabelFacts.company ?? null,
      location: structured.location ?? microdata.location ?? textFacts.location ?? domLabelFacts.location ?? null,
      salary: structured.salary ?? textFacts.salary ?? domLabelFacts.salary ?? null,
      hours: textFacts.hours ?? domLabelFacts.hours ?? null,
      contractType: structured.contractType ?? textFacts.contractType ?? domLabelFacts.contractType ?? null,
      description: structured.description ?? domDescription ?? null,
      contactPerson: textFacts.contactPerson ?? domLabelFacts.contactPerson ?? null,
      phone: page.contacts.phone ?? null,
      email: page.contacts.email ?? null,
      sourceUrl: page.url,
    };
  }

  const hasJsonLd = jsonLdFacts.length > 0;
  const results = (hasJsonLd ? jsonLdFacts : [{}]).map(build);
  const plausible = results.filter(r => hasJsonLd || isPlausibleVacancyPage(r));
  return plausible.length ? plausible : undefined;
}

/**
 * Without JobPosting JSON-LD (structured data is definitive on its own), a page is only accepted
 * as a real vacancy record when at least two *independent* vacancy-specific signal groups are
 * present — never just one. This is what a vacancy overview or a careers landing page can get
 * wrong: such a page routinely embeds several *other* vacancies' own teaser/preview widgets (the
 * same location/salary/hours/contract-type icon group real detail pages use for their own job),
 * so location/salary/hours/contractType alone is exactly as "rich-looking" on an overview page as
 * on a real one — it is evidence of *a* job info widget being present on the page, not evidence
 * that the page's own subject is a specific vacancy. A second, independently-sourced signal
 * (a named contact person, a direct phone/email, a named employer, or an explicit description
 * block) is required before the page counts as a genuine vacancy detail page.
 */
function isPlausibleVacancyPage(r: VacancyFacts): boolean {
  let groups = 0;
  if (r.location || r.salary || r.hours || r.contractType) groups++;
  if (r.company) groups++;
  if (r.contactPerson) groups++;
  if (r.phone || r.email) groups++;
  if (r.description) groups++;
  return groups >= 2;
}
