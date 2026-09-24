import { loadBuffer } from 'cheerio';
import { fetchPublicUrl, type HttpTransport } from './http.js';
import { linkPriority, type PriorityTier } from './url-policy.js';
import { extractContacts, type ContactNormalizers } from '../extract/contacts.js';
import { CRAWL_POLICY, type CrawlPage } from './website-crawler.js';
import type { RobotsPolicy } from './robots.js';

export interface SinglePageFetchOptions<TFacts> {
  extract: (page: CrawlPage) => TFacts | TFacts[] | undefined;
  contactNormalizers: ContactNormalizers;
  linkPriorityExtraTiers?: PriorityTier[];
  userAgent?: string;
  transport?: HttpTransport;
  /** Opt-in: check robots.txt (see createRobotsPolicy) before the page is requested. Without it the fetch is exactly as before. */
  robots?: RobotsPolicy;
}

export interface SinglePageFetchResult<TFacts> {
  url: string;
  status: 'succeeded' | 'failed';
  httpStatus: number | null;
  error: string | null;
  data: TFacts[] | undefined;
  /** Set when the page was not requested because of a policy the caller opted in to. */
  blockedBy?: 'robots';
}

/**
 * Fetches and extracts exactly one page — no link-following, no robots.txt/sitemap discovery, no
 * multi-page crawl budget. This is the primitive a "candidate URL" source (e.g. a search-result
 * page — see ../search/provider.ts) needs: each candidate is its own already-known URL, not a
 * website to explore from its homepage, and `crawlWebsite()` always resets to the origin's own
 * homepage (see websiteScope) — the wrong behavior for a specific deep link a search provider
 * already found. Reuses the exact same SSRF-safe transport (`fetchPublicUrl`), contact
 * extraction and `extract` callback shape `crawlWebsite()` uses per page, so a domain's own
 * extractor (e.g. `extractVacancy`) works completely unchanged against either path.
 */
export async function fetchAndExtractPage<TFacts>(url: string, options: SinglePageFetchOptions<TFacts>): Promise<SinglePageFetchResult<TFacts>> {
  const transport = options.transport ?? fetchPublicUrl;
  const userAgent = options.userAgent ?? CRAWL_POLICY.userAgent;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { url, status: 'failed', httpStatus: null, error: 'Ongeldige URL.', data: undefined }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return { url, status: 'failed', httpStatus: null, error: 'Alleen publieke http(s) URLs worden ondersteund.', data: undefined };
  }

  if (options.robots) {
    const verdict = await options.robots.check(url);
    if (!verdict.allowed) return { url, status: 'failed', httpStatus: null, error: verdict.reason ?? 'Geblokkeerd door robots.txt.', data: undefined, blockedBy: 'robots' };
  }

  let response;
  try { response = await transport(url, userAgent); }
  catch (error) { return { url, status: 'failed', httpStatus: null, error: error instanceof Error ? error.message : String(error), data: undefined }; }

  if (response.status < 200 || response.status >= 300) {
    return { url, status: 'failed', httpStatus: response.status, error: `HTTP ${response.status}`, data: undefined };
  }
  const contentType = response.headers['content-type'] ?? '';
  if (!/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
    return { url, status: 'failed', httpStatus: response.status, error: 'Geen HTML-pagina.', data: undefined };
  }

  const $ = loadBuffer(response.body);
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const priority = linkPriority(url, '', options.linkPriorityExtraTiers ?? []);
  const contacts = extractContacts($, domain, options.contactNormalizers);
  const extracted = options.extract({ $, url, isHomepage: false, priority, contacts });
  const data = extracted === undefined ? undefined : Array.isArray(extracted) ? extracted : [extracted];
  return { url, status: 'succeeded', httpStatus: response.status, error: null, data };
}
