/**
 * A domain-neutral "turn a search query into candidate URLs" primitive — the exact counterpart
 * to ../vision/provider.ts, but for web search instead of image analysis. This package has no
 * idea what a caller is searching for (a job vacancy, an accommodation listing, anything else):
 * a caller supplies a plain query string via `SourceSearchInput`; this file only performs the
 * search call and hands back candidate URLs. A search result is only ever a *candidate* — this
 * file never decides whether a candidate is actually relevant, that is entirely the caller's own
 * job (see domains/vacancies's own vacancy extractor + plausibility check for a real example of
 * turning a candidate into a trustworthy record, never trusting the search result on its own).
 */

/** One candidate source a search provider found — never a fact in itself, only a URL worth
 * fetching and running through the caller's own extractor. */
export interface SearchCandidate {
  url: string;
  title: string | null;
  snippet: string | null;
  /** Which provider produced this candidate (e.g. "brave") — metadata only, never persisted as
   * if it were part of the discovered record itself. */
  source: string;
}

export interface SourceSearchInput {
  query: string;
  /** ISO 3166-1 alpha-2 country code (e.g. "NL"), if the caller wants results biased to one
   * country. Left to the provider to interpret; this package attaches no meaning to it itself. */
  country?: string;
  /** BCP 47 language tag (e.g. "nl"), if the caller wants results in one language. */
  language?: string;
  /** How many results to ask the provider for. A provider may return fewer. */
  count?: number;
}

export interface SourceSearchProvider {
  search(input: SourceSearchInput): Promise<SearchCandidate[]>;
}

export interface BraveSearchProviderOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Override only for testing — the real endpoint otherwise. */
  endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_COUNT = 20;

function text(v: unknown, max = 2000): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
}

/**
 * Brave Search API implementation of SourceSearchProvider — the only file in this package that
 * knows Brave's REST API shape. The API key is a required constructor parameter, read from
 * `process.env` by the caller only (never inside this package — see createGeminiVisionProvider
 * for the exact same convention), never logged, and never included in any error message this
 * function throws.
 */
export function createBraveSearchProvider(apiKey: string, options: BraveSearchProviderOptions = {}): SourceSearchProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async search(input: SourceSearchInput): Promise<SearchCandidate[]> {
      if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY is niet geconfigureerd.');
      const url = new URL(endpoint);
      url.searchParams.set('q', input.query);
      if (input.country) url.searchParams.set('country', input.country);
      if (input.language) url.searchParams.set('search_lang', input.language);
      url.searchParams.set('count', String(Math.min(Math.max(1, input.count ?? 10), MAX_COUNT)));
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await doFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-subscription-token': apiKey },
        signal,
      });
      if (!response.ok) throw new Error(`Brave Search-aanroep mislukt (status ${response.status}).`);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new Error('Brave Search-antwoord was geen geldige JSON.'); }
      const results = (payload as { web?: { results?: unknown[] } })?.web?.results ?? [];
      const candidates: SearchCandidate[] = [];
      for (const entry of Array.isArray(results) ? results : []) {
        const record = entry as { url?: unknown; title?: unknown; description?: unknown };
        const candidateUrl = text(record.url, 2000);
        if (!candidateUrl) continue;
        candidates.push({ url: candidateUrl, title: text(record.title, 500), snippet: text(record.description, 2000), source: 'brave' });
      }
      return candidates;
    },
  };
}
