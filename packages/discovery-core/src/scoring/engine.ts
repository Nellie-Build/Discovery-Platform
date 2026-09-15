/**
 * A domain-neutral "sum weighted signals, clamp, split reasons by sign" primitive — nothing
 * more. This package has no opinion on what a "signal" is (a hotel keyword, a WhatsApp number,
 * a filled-in salary field): a domain module supplies its own `ScoringRule[]`, this file only
 * runs them and adds up the result. See domains/vacancies/src/scoring/completeness.ts for a
 * real, deliberately simple rule set built on top of this exact `runScoring()`.
 */

/** One rule's outcome for one record: `null` means the rule did not apply at all (not "applied
 * with zero points") — a rule that never fires never shows up in either reasons list. */
export interface ScoringContribution {
  points: number;
  reason: string;
}

/** A single named signal. `evaluate` is a pure function of the record — it may read whatever
 * pre-computed shape the domain wants (its own "signals" object, or the raw record itself). */
export interface ScoringRule<T> {
  id: string;
  evaluate(record: T): ScoringContribution | null;
}

export interface ScoringOptions<T> {
  /** Defaults to 0. */
  min?: number;
  /** Defaults to 100. */
  max?: number;
  /**
   * Applied to the already-clamped raw total before the final clamp — the seam a domain uses
   * to express "certain signals cap the score outright" (e.g. an accommodation domain's "a
   * hotel can never score above 20") without this package ever needing to know what a hotel is:
   * the domain's own cap function closes over whatever facts it needs from `record`.
   */
  cap?: (record: T, rawScore: number) => number;
}

export interface ScoringResult {
  score: number;
  /** Every rule that actually fired, in the order the rules were given — never re-sorted. */
  contributions: ScoringContribution[];
  /** `contributions` split by sign — a rule contributing exactly 0 points appears in neither. */
  positiveReasons: ScoringContribution[];
  negativeReasons: ScoringContribution[];
}

export function runScoring<T>(record: T, rules: ScoringRule<T>[], options: ScoringOptions<T> = {}): ScoringResult {
  const min = options.min ?? 0;
  const max = options.max ?? 100;
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  const contributions: ScoringContribution[] = [];
  for (const rule of rules) {
    const contribution = rule.evaluate(record);
    if (contribution) contributions.push(contribution);
  }
  const raw = clamp(contributions.reduce((sum, c) => sum + c.points, 0));
  const score = clamp(options.cap ? options.cap(record, raw) : raw);

  return {
    score,
    contributions,
    positiveReasons: contributions.filter(c => c.points > 0),
    negativeReasons: contributions.filter(c => c.points < 0),
  };
}
