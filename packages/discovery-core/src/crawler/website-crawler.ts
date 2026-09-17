import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadBuffer, type CheerioAPI } from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}
// robots-parser ships a self-referencing ambient module declaration that breaks
// TS's NodeNext default-import typing, so load the CJS export directly instead.
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, robotstxt: string) => Robot;
import { fetchPublicUrl, type HttpTransport, type HttpResult } from './http.js';
import { websiteScope, linkPriority, type PriorityTier } from './url-policy.js';
import { extractContacts, mergeContacts, type ExtractedContacts, type ContactNormalizers } from '../extract/contacts.js';
import type { CrawlRecord, CrawlResult, ExtractedPage } from './types.js';

export const CRAWL_POLICY = {
  userAgent: 'DiscoveryCoreBot/1.0', maxPages: 10, maxMetadataRequests: 8,
  minDelayMs: 2000, maxRedirects: 3, maxDurationMs: 300_000,
};

/** Everything a domain's own `extract` callback gets to look at for one successfully fetched
 * HTML page — the parsed document, plus the two things this package already knows how to
 * compute generically (which page-category priority this URL falls into, and its own contact
 * details) so the domain never needs to recompute them. */
export interface CrawlPage {
  $: CheerioAPI;
  url: string;
  isHomepage: boolean;
  /** This page's own linkPriority() ranking (see url-policy.ts) — lower means the crawler
   * considered it more likely to be a genuinely useful page (contact/about/reservation/...).
   * A domain can use this to decide, itself, which pages it trusts for its own numeric/detail
   * extraction — this package has no opinion on that threshold. */
  priority: number;
  contacts: ExtractedContacts;
}

export interface CrawlOptions<TFacts> {
  /**
   * The one seam that makes this crawler domain-neutral: called once per successfully fetched
   * HTML page, with everything above already computed. Returns whatever facts the domain cares
   * about for that page — one, several (e.g. one per structured-data node found on the page),
   * or `undefined` for "nothing found here". This package never inspects, scores, or merges the
   * returned facts; combining what several pages said is the domain's own responsibility.
   */
  extract: (page: CrawlPage) => TFacts | TFacts[] | undefined;
  /** How to turn a raw phone/e-mail string into a normalized one — deliberately not built into
   * this package (see extract/contacts.ts's own doc comment for why). */
  contactNormalizers: ContactNormalizers;
  /** Extra page-category tiers (see url-policy.ts's linkPriority) a domain wants considered
   * during crawl-order ranking and reflected in `CrawlPage.priority` — e.g. "does this URL look
   * like a room/unit detail page" for an accommodation domain. Defaults to none. */
  linkPriorityExtraTiers?: PriorityTier[];
  userAgent?: string;
  expectedName?: string | null;
  maxDurationMs?: number;
  transport?: HttpTransport;
  onRecord?: (record: CrawlRecord) => Promise<void>;
  // Injectable clock for deterministic tests; the CLI always uses real time.
  clock?: { now(): number; sleep(ms: number): Promise<unknown> };
}

export async function crawlWebsite<TFacts>(website: string, options: CrawlOptions<TFacts>): Promise<CrawlResult<TFacts>> {
  const scope = websiteScope(website);
  const transport = options.transport ?? fetchPublicUrl;
  const clock = options.clock ?? { now: Date.now, sleep };
  const userAgent = options.userAgent ?? CRAWL_POLICY.userAgent;
  const linkPriorityExtraTiers = options.linkPriorityExtraTiers ?? [];
  const start = clock.now();
  const maxDurationMs = Math.min(CRAWL_POLICY.maxDurationMs, options.maxDurationMs ?? CRAWL_POLICY.maxDurationMs);
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new Error('Ongeldige crawl-tijdslimiet.');
  let lastRequest = -Infinity, delay = CRAWL_POLICY.minDelayMs;
  let pages = 0, metadata = 0, stopped: string | null = null;
  let homepageStatus: number | null = null, homepageBlocked = false;
  const records: CrawlRecord[] = [], visited = new Set<string>();
  const contactPages: { url: string; contacts: ExtractedContacts }[] = [];
  const extractedPages: ExtractedPage<TFacts>[] = [];
  const candidates = new Map<string, number>();
  const robots = new Map<string, Promise<{ parser: ReturnType<typeof robotsParser>; error: string | null }>>();
  let checkedSitemap = false;
  const errors: string[] = [];

  async function record(value: Omit<CrawlRecord, 'sequence'>) {
    const entry = { ...value, sequence: records.length + 1 };
    records.push(entry);
    await options.onRecord?.(entry);
  }
  function blank(url: string, kind: CrawlRecord['kind']): Omit<CrawlRecord, 'sequence'> {
    return { url, kind, attempted: false, status: 'blocked', httpStatus: null,
      fetchedAt: new Date(clock.now()).toISOString(), durationMs: 0, contentType: null,
      bytes: 0, title: null, sha256: null, redirectTo: null, error: null };
  }
  async function denied(url: string, kind: CrawlRecord['kind'], error: string) {
    await record({ ...blank(url, kind), error });
    if (kind === 'page') errors.push(error);
  }
  function add(input: string, base: string, label = '') {
    const url = scope.normalize(input, base);
    if (!url || visited.has(url) || candidates.size >= 500) return;
    const priority = linkPriority(url, label, linkPriorityExtraTiers);
    candidates.set(url, Math.min(candidates.get(url) ?? Infinity, priority));
  }

  async function policy(url: string) {
    const origin = new URL(url).origin;
    if (!robots.has(origin)) {
      robots.set(origin, (async () => {
        const robotsUrl = `${origin}/robots.txt`;
        const result = await get(robotsUrl, 'robots');
        let body = '', error: string | null = null;
        if (!result || ![200, 404, 410].includes(result.response.status)) {
          body = 'User-agent: *\nDisallow: /';
          error = 'robots.txt kon niet betrouwbaar worden gelezen; crawl geblokkeerd.';
        } else if (result.response.status === 200) body = result.response.body.toString('utf8');
        const parser = robotsParser(robotsUrl, body);
        const crawlDelay = parser.getCrawlDelay(userAgent);
        if (crawlDelay !== undefined && Number.isFinite(crawlDelay) && crawlDelay >= 0) delay = Math.max(delay, crawlDelay * 1000);
        return { parser, error };
      })());
    }
    return robots.get(origin)!;
  }

  async function get(initial: string, kind: CrawlRecord['kind']): Promise<{ response: HttpResult; url: string } | null> {
    let url = initial;
    const chain = new Set<string>();
    for (let hop = 0; hop <= CRAWL_POLICY.maxRedirects; hop++) {
      if (!scope.normalize(url, undefined, false)) { await denied(url, kind, 'URL buiten het toegestane domein.'); return null; }
      if (chain.has(url)) { await denied(url, kind, 'Redirectlus gestopt.'); return null; }
      chain.add(url);
      if (stopped) { await denied(url, kind, stopped); return null; }
      if (kind !== 'robots') {
        const rule = await policy(url);
        if (rule.error || rule.parser.isAllowed(url, userAgent) === false) {
          await denied(url, kind, rule.error ?? 'Geblokkeerd door robots.txt.');
          return null;
        }
      }
      if (stopped) { await denied(url, kind, stopped); return null; }
      if ((kind === 'page' ? pages >= CRAWL_POLICY.maxPages : metadata >= CRAWL_POLICY.maxMetadataRequests)) {
        await denied(url, kind, 'Verzoeklimiet bereikt.'); return null;
      }
      const wait = Math.max(0, lastRequest + delay - clock.now());
      if (clock.now() + wait - start >= maxDurationMs) {
        stopped = 'Tijdslimiet bereikt; vereiste crawl-delay wordt niet verkort.';
        await denied(url, kind, stopped); return null;
      }
      if (wait) await clock.sleep(wait);
      lastRequest = clock.now();
      if (kind === 'page') { pages++; visited.add(url); } else metadata++;
      let response: HttpResult;
      try { response = await transport(url, userAgent); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await record({ ...blank(url, kind), attempted: true, status: 'failed', durationMs: clock.now() - lastRequest, error: message });
        if (kind === 'page') errors.push(message);
        return null;
      }
      const redirect = [301, 302, 303, 307, 308].includes(response.status);
      const location = response.headers.location;
      const destination = redirect && location ? scope.normalize(location, url, false) : null;
      const contentType = response.headers['content-type'] ?? null;
      let title: string | null = null;
      if (kind === 'page' && /(?:text\/html|application\/xhtml\+xml)/i.test(contentType ?? '')) {
        title = loadBuffer(response.body)('title').first().text().trim().slice(0, 500) || null;
      }
      let error: string | null = response.status >= 400 ? `HTTP ${response.status}` : null;
      if (redirect && !destination) error = 'Redirect zonder geldige bestemming binnen het toegestane domein.';
      if (redirect && hop === CRAWL_POLICY.maxRedirects) error = 'Maximum aantal redirects bereikt.';
      await record({ ...blank(url, kind), attempted: true,
        status: error ? 'http_error' : redirect ? 'redirect' : 'ok', httpStatus: response.status,
        durationMs: clock.now() - lastRequest, contentType, bytes: response.body.length, title,
        sha256: createHash('sha256').update(response.body).digest('hex'), redirectTo: destination, error });
      if (kind === 'page' && error) errors.push(error);
      if ([429, 503].includes(response.status)) stopped = `HTTP ${response.status}: website vraagt om rust; verdere verzoeken gestopt.`;
      if (redirect) {
        if (error || !destination) return null;
        url = destination;
        continue;
      }
      return { response, url };
    }
    return null;
  }

  async function sitemap(home: string) {
    const pending = [new URL('/sitemap.xml', home).href];
    const rule = await policy(home);
    pending.push(...rule.parser.getSitemaps());
    const done = new Set<string>();
    const parser = new XMLParser({ ignoreAttributes: true, processEntities: false, parseTagValue: false, removeNSPrefix: true });
    while (pending.length && done.size < 3 && !stopped) {
      const url = scope.normalize(pending.shift()!, home, false);
      if (!url || done.has(url)) continue;
      done.add(url);
      const result = await get(url, 'sitemap');
      if (!result || result.response.status !== 200) continue;
      const xml = result.response.body.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) continue;
      const data = parser.parse(xml);
      const list = (value: unknown): { loc?: unknown }[] => Array.isArray(value) ? value : value ? [value] as { loc?: unknown }[] : [];
      for (const item of list(data.urlset?.url).slice(0, 1000)) if (typeof item.loc === 'string') add(item.loc, result.url);
      for (const item of list(data.sitemapindex?.sitemap).slice(0, 10)) if (typeof item.loc === 'string') pending.push(item.loc);
    }
  }

  // This crawler is deliberately serial. Crawlee's autoscaling adds process-tree
  // sampling (which shells out to `ps` on Linux) without providing concurrency here.
  async function crawlPage(url: string) {
    visited.add(url);
    const result = await get(url, 'page');
    if (url === scope.homepage) {
      homepageStatus = records.filter(item => item.kind === 'page' && item.attempted).at(-1)?.httpStatus ?? null;
      homepageBlocked = !result && records.some(item => item.kind === 'page' && !item.attempted && /robots/.test(item.error ?? ''));
    }
    if (result && result.response.status >= 200 && result.response.status < 300) {
      const contentType = result.response.headers['content-type'] ?? '';
      if (/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
        const $ = loadBuffer(result.response.body);
        const base = $('base[href]').first().attr('href');
        let baseUrl = result.url;
        try { if (base) baseUrl = new URL(base, result.url).href; } catch { /* Use document URL for malformed base. */ }
        for (const anchor of $('a[href]').toArray().slice(0, 2000)) add($(anchor).attr('href')!, baseUrl, $(anchor).text());
        const isHomepage = result.url === scope.homepage;
        const priority = linkPriority(result.url, '', linkPriorityExtraTiers);
        const contacts = extractContacts($, scope.domain, options.contactNormalizers);
        contactPages.push({ url: result.url, contacts });
        const extracted = options.extract({ $, url: result.url, isHomepage, priority, contacts });
        if (extracted !== undefined) {
          for (const data of Array.isArray(extracted) ? extracted : [extracted]) extractedPages.push({ url: result.url, data, isHomepage });
        }
      } else errors.push(`Geen HTML-pagina: ${result.url}`);
      if (!checkedSitemap) { checkedSitemap = true; await sitemap(result.url); }
    }
  }
  try {
    // The caller's own requested URL (its own path, not just the site's origin) is always
    // fetched first — see websiteScope's own doc comment on `requestedPage`. A direct deep link
    // (e.g. one specific vacancy detail page) must never be silently discarded down to a
    // homepage-only crawl before extraction ever gets a chance to run on it. The site's real
    // homepage is still queued as a normal candidate (unless it *is* the requested page) so it
    // stays available as a rich source of further navigation links, exactly as before.
    if (scope.requestedPage !== scope.homepage) add(scope.homepage, scope.homepage);
    let next: string | undefined = scope.requestedPage;
    let handled = 0;
    while (next && !stopped && pages < CRAWL_POLICY.maxPages && handled < CRAWL_POLICY.maxPages) {
      await crawlPage(next);
      handled++;
      next = [...candidates].filter(([url]) => !visited.has(url)).sort((a, b) => a[1] - b[1])[0]?.[0];
      if (next) candidates.delete(next);
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
    errors.push(stopped);
  }
  const successful = records.some(item => item.kind === 'page' && item.status === 'ok' &&
    (item.httpStatus ?? 0) >= 200 && (item.httpStatus ?? 0) < 300 && /html/i.test(item.contentType ?? ''));
  if (stopped) errors.push(stopped);
  return { homepage: scope.homepage, domain: scope.domain, pagesVisited: pages, httpStatus: homepageStatus,
    status: homepageBlocked ? 'blocked' : !successful ? 'failed' : errors.length ? 'partial' : 'succeeded',
    error: errors.length ? [...new Set(errors)].join('; ').slice(0, 4000) : null, records,
    contacts: mergeContacts(contactPages), extractedPages };
}
