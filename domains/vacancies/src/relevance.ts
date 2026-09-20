/**
 * Query relevance for branch/jobboard search: a vacancy candidate is only accepted for a run when
 * it is demonstrably relevant to what the user actually typed (branch + optional keywords) — being
 * a technically valid, plausible vacancy page is not enough on its own (see extract-vacancy.ts's
 * own isPlausibleVacancyPage, which runs *before* this and answers a different question: "is this
 * a real vacancy page at all", not "is it the vacancy the user searched for").
 *
 * Deliberately dumb on purpose: no AI, no automatic translation, no invented synonyms, no
 * site-specific rules. The only normalization allowed is lowercasing, whitespace collapsing and
 * punctuation stripping — matching is on whole words (plus the start of a compound word, see
 * `matchesTerm`) against the user's own branch/keywords text, nothing more. A vacancy need not
 * contain every search word (that would be too strict — see the "Project Manager OT
 * Cybersecurity" / "Projectleider security" cases in this file's own tests), but it needs real
 * *content* evidence in its title, description or company (see `scoreVacancyRelevance`). A
 * location match, or a region word inside the description, is never evidence on its own.
 */
import type { VacancyFacts } from './extract-vacancy.js';

export interface VacancyRelevanceQuery {
  /** Required — e.g. "Security". Never reworded/translated (see source-discovery.ts). */
  branch: string;
  /** Optional extra free-text terms, e.g. "Project Manager". */
  keywords?: string | null;
  region?: string | null;
}

export type RelevanceAcceptanceReason =
  | 'title_branch_match'
  | 'keyword_phrase_match'
  | 'keyword_title_match'
  | 'description_content_match'
  | 'company_plus_description'
  | 'rejected_location_only'
  | 'rejected_weak_evidence'
  | 'rejected_no_match'
  | 'rejected_no_query_terms';

export interface VacancyRelevanceResult {
  accepted: boolean;
  /** Title matches count 3x a description/company match, a whole phrase counts more than a single
   * word. Kept alongside `relevanceScore` for compatibility; the accept/reject decision is the
   * content rule in `acceptanceReason`, not a score threshold. */
  score: number;
  matchedTerms: string[];
  titleMatches: string[];
  descriptionMatches: string[];
  companyMatches: string[];
  /** Whole user phrases (e.g. "security officer") found in the title or description. */
  phraseMatches: string[];
  /** Lexical evidence only (the user's region words found in the vacancy's location). Never
   * sufficient on its own, never a reason to accept; a small ranking bonus at most. */
  locationMatch: boolean | null;
  relevanceScore: number;
  /** True when title/description/company hold enough *content* evidence for the user's branch and
   * keywords — independent of where the job is. */
  contentMatch: boolean;
  acceptanceReason: RelevanceAcceptanceReason;
}

const TITLE_WEIGHT = 3;
const OTHER_FIELD_WEIGHT = 1;
const PHRASE_WEIGHT = 4;
const LOCATION_BONUS = 1;
/** A branch/keyword term mentioned only once in a long description is usually incidental
 * ("Middelbaar onderwijs afgerond" in a carpenter's requirements). Description-only evidence
 * therefore needs at least this many mentions of the user's content terms. */
const DESCRIPTION_MIN_MENTIONS = 2;
/** Compound matching (a word that *starts with* the term, e.g. "onderwijsassistent") only for
 * terms long enough that a prefix is meaningful. Never a suffix ("cybersecurity" is not "security"). */
const COMPOUND_MIN_TERM_LENGTH = 5;
/** Two words of the same family ("beveiliging" / "beveiliger", "onderwijs" / "onderwijzer") share a
 * long common start. Purely lexical — never a synonym, translation or expansion. */
const STEM_MIN_LENGTH = 7;
const STEM_MIN_SHARE = 0.7;
/** Description-only evidence must also be a meaningful share of the description, so a long text
 * that merely mentions the term in passing does not count. */
const DESCRIPTION_MIN_DENSITY = 0.007;

const STOPWORDS = new Set(['en', 'of', 'de', 'het', 'een', 'in', 'op', 'voor', 'van', 'the', 'and', 'or', 'for', 'to', 'at']);

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Single-word tokens only, length >= 2 and not a function word — long enough to mean something
 * ("IT", "OT" stay; bare punctuation/single letters and "en"/"of" never become a "match anything"
 * term). */
function tokenize(value: string): string[] {
  return normalizeText(value).split(' ').filter(token => token.length >= 2 && !STOPWORDS.has(token));
}

/** What the user typed, split by role: `branch` words, `keywords` (standalone words the user
 * typed), `derived` (parts of a hyphenated word such as "zuid-holland" — never evidence on their
 * own) and `phrases` (adjacent typed words such as "security officer", or a hyphenated word as a
 * whole). No synonyms, translations or other invented terms. */
interface QueryModel {
  branch: string[];
  keywords: string[];
  /** Words the user typed next to a branch word ("officer" in "security officer"): they qualify
   * the branch, so on their own ("Facility Officer") they are not evidence. */
  bound: string[];
  derived: string[];
  phrases: { tokens: string[]; hyphenOnly: boolean }[];
}

function buildQueryModel(query: VacancyRelevanceQuery): QueryModel {
  const model: QueryModel = { branch: [...new Set(tokenize(query.branch))], keywords: [], bound: [], derived: [], phrases: [] };
  const seen = new Set<string>();
  const addPhrase = (tokens: string[], hyphenOnly: boolean) => {
    const key = tokens.join(' ');
    if (tokens.length < 2 || seen.has(key)) return;
    seen.add(key);
    model.phrases.push({ tokens, hyphenOnly });
  };
  for (const segment of (query.keywords ?? '').split(/[,;\n]+/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean).map(word => tokenize(word)).filter(tokens => tokens.length > 0);
    for (const tokens of words) {
      if (tokens.length > 1) { model.derived.push(...tokens); addPhrase(tokens, true); }
      else model.keywords.push(tokens[0]);
    }
    // Adjacent typed words form phrases ("security officer"); so does the whole segment.
    for (let i = 0; i + 1 < words.length; i++) addPhrase([...words[i], ...words[i + 1]], false);
    if (words.length > 2) addPhrase(words.flat(), false);
  }
  // Only an adjacent pair counts ("security officer"): a whole typed segment would bind every word.
  for (const phrase of model.phrases) {
    if (phrase.hyphenOnly || phrase.tokens.length !== 2 || !phrase.tokens.some(token => model.branch.includes(token))) continue;
    for (const token of phrase.tokens) if (!model.branch.includes(token)) model.bound.push(token);
  }
  model.bound = [...new Set(model.bound)];
  model.keywords = [...new Set(model.keywords)].filter(term => !model.branch.includes(term) && !model.bound.includes(term));
  model.derived = [...new Set(model.derived)].filter(term => !model.branch.includes(term) && !model.keywords.includes(term));
  return model;
}

/** Words of a field, normalized. */
function wordsOf(value: string | null | undefined): string[] {
  const normalized = value ? normalizeText(value) : '';
  return normalized ? normalized.split(' ') : [];
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** A whole-word match, the start of a compound ("onderwijs" -> "onderwijsassistent"), or a word of
 * the same family sharing a long common start ("beveiliging" -> "beveiliger"). Never a suffix
 * match: "cybersecurity" is not "security". */
function matchesTerm(word: string, term: string): boolean {
  if (word === term) return true;
  if (term.length >= COMPOUND_MIN_TERM_LENGTH && word.length > term.length && word.startsWith(term)) return true;
  const shared = commonPrefixLength(word, term);
  return shared >= STEM_MIN_LENGTH && shared >= Math.ceil(STEM_MIN_SHARE * term.length);
}

function countMentions(words: string[], terms: string[]): number {
  let count = 0;
  for (const word of words) if (terms.some(term => matchesTerm(word, term))) count++;
  return count;
}

function findTerms(terms: string[], words: string[]): string[] {
  return terms.filter(term => words.some(word => matchesTerm(word, term)));
}

function phraseCount(phrase: string[], words: string[]): number {
  let count = 0;
  for (let i = 0; i + phrase.length <= words.length; i++) if (phrase.every((part, j) => words[i + j] === part)) count++;
  return count;
}

/**
 * Scores one vacancy candidate against the user's own branch/keywords query. Evidence comes only
 * from explicit source fields already on VacancyFacts — title, description and company — never
 * guessed, never enriched with anything the source didn't actually say. The location is only ever
 * a diagnostic and a small ranking bonus: a location match alone (or a region word inside the
 * description) can never make a vacancy relevant.
 *
 * A candidate is accepted when the *content* evidence is enough (`acceptanceReason`):
 *  1. `title_branch_match` — a branch word is in the title;
 *  2. `keyword_phrase_match` — a phrase the user typed ("security officer") is in the title;
 *  3. `keyword_title_match` — a standalone keyword the user typed is in the title;
 *  4. `description_content_match` — the description repeats the user's content terms, often
 *     enough and as a meaningful share of the text;
 *  5. `company_plus_description` — the company name matches and the description mentions it too.
 * A hyphenated keyword ("zuid-holland") is kept as a phrase, but neither the phrase nor its parts
 * ("zuid", "holland") count as content evidence: they are diagnostics only. Words are matched as
 * whole words, or as the start of a compound ("onderwijs" matches "onderwijsassistent", never
 * "cybersecurity").
 */
export function scoreVacancyRelevance(facts: VacancyFacts, query: VacancyRelevanceQuery): VacancyRelevanceResult {
  const model = buildQueryModel(query);
  const contentTerms = [...model.branch, ...model.keywords];
  const allTerms = [...contentTerms, ...model.bound, ...model.derived];
  const title = wordsOf(facts.title);
  const description = wordsOf(facts.description);
  const company = wordsOf(facts.company);
  const otherWords = [...description, ...company, ...wordsOf(facts.contractType)];

  const titleMatches = findTerms(allTerms, title);
  const otherMatches = findTerms(allTerms, otherWords);
  const matchedTerms = [...new Set([...titleMatches, ...otherMatches])];

  const contentPhrases = model.phrases.filter(phrase => !phrase.hyphenOnly);
  const phraseMatches = contentPhrases
    .filter(phrase => phraseCount(phrase.tokens, title) + phraseCount(phrase.tokens, description) > 0)
    .map(phrase => phrase.tokens.join(' '));
  const titlePhrase = contentPhrases.some(phrase => phraseCount(phrase.tokens, title) > 0);

  const titleBranch = findTerms(model.branch, title).length > 0;
  const titleKeyword = findTerms(model.keywords, title).length > 0;
  const descriptionMentions = countMentions(description, contentTerms)
    + contentPhrases.reduce((sum, phrase) => sum + phraseCount(phrase.tokens, description), 0);
  const descriptionStrong = descriptionMentions >= DESCRIPTION_MIN_MENTIONS && descriptionMentions / Math.max(1, description.length) >= DESCRIPTION_MIN_DENSITY;
  const companyContent = findTerms(contentTerms, company).length > 0;

  let acceptanceReason: RelevanceAcceptanceReason;
  if (allTerms.length === 0) acceptanceReason = 'rejected_no_query_terms';
  else if (titleBranch) acceptanceReason = 'title_branch_match';
  else if (titlePhrase) acceptanceReason = 'keyword_phrase_match';
  else if (titleKeyword) acceptanceReason = 'keyword_title_match';
  else if (descriptionStrong) acceptanceReason = 'description_content_match';
  else if (companyContent && descriptionMentions >= 1) acceptanceReason = 'company_plus_description';
  else if (matchedTerms.length === 0) acceptanceReason = 'rejected_no_match';
  else acceptanceReason = matchedTerms.every(term => model.derived.includes(term)) ? 'rejected_location_only' : 'rejected_weak_evidence';
  const contentMatch = !acceptanceReason.startsWith('rejected_');

  const locationMatch = query.region && facts.location ? findTerms(tokenize(query.region), wordsOf(facts.location)).length > 0 : null;
  const score = titleMatches.length * TITLE_WEIGHT + otherMatches.length * OTHER_FIELD_WEIGHT + phraseMatches.length * PHRASE_WEIGHT
    + (contentMatch && locationMatch ? LOCATION_BONUS : 0);
  return {
    accepted: contentMatch, score, relevanceScore: score, matchedTerms, titleMatches,
    descriptionMatches: findTerms(allTerms, description), companyMatches: findTerms(allTerms, company),
    phraseMatches, locationMatch, contentMatch, acceptanceReason,
  };
}
