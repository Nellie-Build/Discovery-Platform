/**
 * Query relevance for branch/jobboard search: a vacancy candidate is only accepted for a run when
 * it is demonstrably relevant to what the user actually typed (branch + optional keywords) — being
 * a technically valid, plausible vacancy page is not enough on its own (see extract-vacancy.ts's
 * own isPlausibleVacancyPage, which runs *before* this and answers a different question: "is this
 * a real vacancy page at all", not "is it the vacancy the user searched for").
 *
 * Deliberately dumb on purpose: no AI, no automatic translation, no invented synonyms, no
 * site-specific rules. The only normalization allowed is lowercasing, whitespace collapsing and
 * punctuation stripping — matching is plain word-boundary substring matching against the user's
 * own branch/keywords text, nothing more. A vacancy need not contain every search word (that would
 * be too strict — see the "Project Manager OT Cybersecurity" / "Projectleider security" cases in
 * this file's own tests), but a candidate with *no* matching evidence anywhere in its explicit
 * fields must be rejected (the "HR Generalist" case).
 */
import type { VacancyFacts } from './extract-vacancy.js';

export interface VacancyRelevanceQuery {
  /** Required — e.g. "Security". Never reworded/translated (see source-discovery.ts). */
  branch: string;
  /** Optional extra free-text terms, e.g. "Project Manager". */
  keywords?: string | null;
}

export interface VacancyRelevanceResult {
  accepted: boolean;
  /** Title matches count 3x a description/other-field match — evidence in the vacancy's own
   * headline is stronger than evidence buried in body text. Not itself the accept/reject rule
   * (any match at all accepts); kept for future ranking use. */
  score: number;
  matchedTerms: string[];
}

const TITLE_WEIGHT = 3;
const OTHER_FIELD_WEIGHT = 1;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Single-word tokens only, length >= 2 — long enough to mean something ("IT", "OT" stay; bare
 * punctuation/single letters left over from stripping never become a "match anything" term). */
function tokenize(value: string): string[] {
  return normalizeText(value).split(' ').filter(token => token.length >= 2);
}

function queryTerms(query: VacancyRelevanceQuery): string[] {
  const terms = tokenize(query.branch);
  if (query.keywords) terms.push(...tokenize(query.keywords));
  return [...new Set(terms)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word matches only — "security" must never match inside "cybersecurity", exactly like a
 * label match elsewhere in this domain never matches a substring of running prose. */
function findMatches(terms: string[], fieldText: string | null | undefined): string[] {
  if (!fieldText) return [];
  const normalized = normalizeText(fieldText);
  if (!normalized) return [];
  const padded = ` ${normalized} `;
  const matched: string[] = [];
  for (const term of terms) {
    if (new RegExp(`\\s${escapeRegExp(term)}\\s`).test(padded)) matched.push(term);
  }
  return matched;
}

/**
 * Scores one vacancy candidate against the user's own branch/keywords query. Evidence comes only
 * from explicit source fields already on VacancyFacts (title, description, company, contractType)
 * — never guessed, never enriched with anything the source didn't actually say. `accepted` is true
 * as soon as *any* query term is found anywhere; the weighted `score` exists for future ranking,
 * not to raise the bar for acceptance (see this file's own header comment on "not too strict").
 */
export function scoreVacancyRelevance(facts: VacancyFacts, query: VacancyRelevanceQuery): VacancyRelevanceResult {
  const terms = queryTerms(query);
  if (terms.length === 0) return { accepted: true, score: 0, matchedTerms: [] };

  const titleMatches = findMatches(terms, facts.title);
  const otherFieldText = [facts.description, facts.company, facts.contractType].filter(Boolean).join(' ');
  const otherMatches = findMatches(terms, otherFieldText);

  const score = titleMatches.length * TITLE_WEIGHT + otherMatches.length * OTHER_FIELD_WEIGHT;
  const matchedTerms = [...new Set([...titleMatches, ...otherMatches])];
  return { accepted: matchedTerms.length > 0, score, matchedTerms };
}
