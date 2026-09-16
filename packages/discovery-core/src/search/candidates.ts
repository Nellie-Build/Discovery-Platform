import type { SearchCandidate } from './provider.js';

export interface NormalizeCandidatesOptions {
  /** A conservative cap on how many candidates survive — protects against an uncontrolled
   * number of downstream page fetches. Defaults to 10. */
  maxCandidates?: number;
}

// Search-engine result/redirect/tracking hosts a candidate should never actually be fetched
// from — these are search infrastructure, never a real vacancy (or any other domain's) source
// page. Generic web-search hygiene, not specific to any one search provider or business domain.
const EXCLUDED_HOST_PATTERN =
  /(^|\.)(google|bing|yahoo|duckduckgo|baidu|yandex)\.[a-z.]+$|(^|\.)search\.brave\.com$|(^|\.)(doubleclick|googlesyndication|googleadservices)\.[a-z.]+$/i;

const TRACKING_PARAMS = /^(utm_.+|fbclid|gclid|msclkid|ref|referrer)$/i;

/**
 * Turns raw search-provider candidates into a clean, deduplicated, bounded list of URLs worth
 * fetching — generic URL hygiene only, no knowledge of what a caller is searching for. Never
 * decides relevance itself: normalize/dedupe is purely mechanical (protocol, host, tracking
 * params, exact-URL duplicates, a hard cap), leaving every actual relevance judgement — is this
 * really a vacancy, an accommodation listing, anything else — entirely to the caller's own
 * extractor and plausibility check.
 */
export function normalizeCandidateUrls(candidates: SearchCandidate[], options: NormalizeCandidatesOptions = {}): SearchCandidate[] {
  const maxCandidates = Math.max(0, options.maxCandidates ?? 10);
  const seen = new Set<string>();
  const result: SearchCandidate[] = [];
  for (const candidate of candidates) {
    if (result.length >= maxCandidates) break;
    let url: URL;
    try { url = new URL(candidate.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    if (EXCLUDED_HOST_PATTERN.test(url.hostname)) continue;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    const normalizedUrl = url.href;
    const key = normalizedUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...candidate, url: normalizedUrl });
  }
  return result;
}
