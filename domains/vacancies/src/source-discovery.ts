/**
 * Turns a user's "search by branch" input (branch/region/keywords) into the plain query string
 * @discovery-platform/core's generic `SourceSearchProvider.search({ query })` takes — the one
 * piece of domain knowledge Source Discovery needs from the vacancies domain: what a *vacancy*
 * search query looks like. discovery-core itself never sees "branch", "region" or "vacature" —
 * only the finished query string.
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
 * Fixed, generic discovery hints ("vacature", "vacatures", "jobs") every branch search adds so a
 * plain branch name ("Security") reads as a vacancy search rather than a generic web search for
 * that industry — never an AI-generated synonym, never anything else invented beyond these three
 * words and the user's own input, kept in the order the user typed it.
 */
export const BRANCH_SEARCH_HINTS: readonly string[] = ['vacature', 'vacatures', 'jobs'];

export function buildBranchSearchQuery(input: BranchSearchInput): string {
  const parts = [...BRANCH_SEARCH_HINTS, input.branch.trim()];
  if (input.keywords?.trim()) parts.push(input.keywords.trim());
  if (input.region?.trim()) parts.push(input.region.trim());
  return parts.join(' ');
}
