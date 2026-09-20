/**
 * Turns a user's "search by branch" input (branch/region/keywords) into the query string each
 * kind of source actually needs — never the same string reused everywhere. discovery-core itself
 * never sees "branch", "region", "vacature" or a job board's own name — only whatever finished
 * string a source's own query parameter takes.
 */
export interface BranchSearchInput {
  /** Required — e.g. "Security". */
  branch: string;
  /** Optional — e.g. "Nederland", "Den Haag" or "Zuid-Holland". */
  region?: string | null;
  /** Optional — extra free-text terms, e.g. "beveiliger security officer". */
  keywords?: string | null;
}

/** Compatibility export. Queries now use only explicit user input. */
export const BRANCH_SEARCH_HINTS: readonly string[] = []; // Kept for API compatibility; no hidden expansion.

/** The query for a general web-search provider (Brave): only the
 * user's own branch/keywords/region, verbatim, in the order they were typed — never reworded,
 * never a synonym, never a hidden translation. Region is folded into this query text because a
 * generic web search has no separate "location" search parameter to give it. */
export function buildBranchSearchQuery(input: BranchSearchInput): string {
  const parts = [input.branch.trim()];
  if (input.keywords?.trim()) parts.push(input.keywords.trim());
  if (input.region?.trim()) parts.push(input.region.trim());
  return parts.join(' ');
}

/**
 * The search term for a job board (ts-jobspy): branch + the user's own keywords, verbatim —
 * nothing else. No web-search discovery hints ("vacature vacatures jobs" is noise a job board
 * never needs, since every result it returns is already a job posting), no automatic
 * synonym/translation ("Beveiliging" must never silently become "Security"), and — unlike the
 * web-search query above — region is deliberately left out of this string entirely: a job board
 * has its own dedicated location/country search parameters (see
 * sources/location.ts's normalizeJobBoardLocation), which is a real provider filter, not just
 * more text appended to the search term.
 */
export function buildJobBoardSearchTerm(input: Pick<BranchSearchInput, 'branch' | 'keywords'>): string {
  const parts = [input.branch.trim()];
  if (input.keywords?.trim()) parts.push(input.keywords.trim());
  return parts.join(' ');
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Removes keywords that merely repeat the search location, so a place the user already entered
 * as "Regio / plaats" never also ends up in the content search term. Only an exact match (ignoring
 * case, hyphens and spacing) is removed — a keyword is never guessed to be geographic — and both a
 * whole keyword segment ("zuid-holland") and a single typed word are compared.
 */
export function removeLocationKeywords(keywords: string | null | undefined, locationTerms: (string | null | undefined)[]): string | null {
  if (!keywords?.trim()) return null;
  const terms = new Set(locationTerms.filter((term): term is string => Boolean(term?.trim())).map(normalizeForCompare).filter(Boolean));
  if (terms.size === 0) return keywords.trim();
  const kept: string[] = [];
  let removedAny = false;
  for (const segment of keywords.split(/([,;\n]+)/)) {
    if (/^[,;\n]+$/.test(segment)) { kept.push(segment); continue; }
    if (terms.has(normalizeForCompare(segment))) { removedAny = true; continue; }
    // A location of up to three words ("Den Haag") may sit anywhere inside a segment.
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const remaining: string[] = [];
    for (let i = 0; i < words.length;) {
      const length = [3, 2, 1].find(size => i + size <= words.length && terms.has(normalizeForCompare(words.slice(i, i + size).join(' '))));
      if (length) { i += length; removedAny = true; } else remaining.push(words[i++]);
    }
    kept.push(remaining.join(' '));
  }
  if (!removedAny) return keywords.trim();
  const cleaned = kept.join('').replace(/\s*[,;\n]+\s*/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '');
  return cleaned || null;
}
