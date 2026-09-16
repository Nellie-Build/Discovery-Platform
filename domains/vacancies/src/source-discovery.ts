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

/**
 * Fixed, generic discovery hints ("vacature", "vacatures", "jobs") a *web search* (e.g. Brave)
 * query adds so a plain branch name ("Security") reads as a vacancy search rather than a generic
 * web search for that industry — never an AI-generated synonym, never anything else invented
 * beyond these three words and the user's own input, kept in the order the user typed it. A job
 * board (ts-jobspy) is not a general web search engine — it never needs these hints; see
 * `buildJobBoardSearchTerm` below for what it actually gets.
 */
export const BRANCH_SEARCH_HINTS: readonly string[] = ['vacature', 'vacatures', 'jobs'];

/** The query for a general web-search provider (Brave): the fixed discovery hints, then the
 * user's own branch/keywords/region, verbatim, in the order they were typed — never reworded,
 * never a synonym, never a hidden translation. Region is folded into this query text because a
 * generic web search has no separate "location" search parameter to give it. */
export function buildBranchSearchQuery(input: BranchSearchInput): string {
  const parts = [...BRANCH_SEARCH_HINTS, input.branch.trim()];
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
