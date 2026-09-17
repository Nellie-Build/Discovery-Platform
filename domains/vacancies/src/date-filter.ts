/**
 * "Posted within N days" filtering — uses only an explicit `postedDate` a source actually
 * reported (structured data, a job-board provider, explicit page metadata — see
 * extract-vacancy.ts's own VacancyFacts.postedDate doc comment). Never guesses a date, and never
 * silently treats "unknown date" as "too old" — that is a deliberate, conservative default a
 * caller can opt out of, not automatic rejection just because a date wasn't reported.
 */
export interface PostedDateFilterOptions {
  /** No filtering at all when unset/0/negative — every vacancy passes regardless of its own
   * postedDate (or lack of one). */
  postedWithinDays?: number | null;
  /** Default `false`: a vacancy with no known postedDate is kept, never rejected just because the
   * date itself is missing. Set `true` to require a known, in-window date instead. */
  rejectUnknownDate?: boolean;
}

export function isWithinPostedWindow(
  fact: { postedDate: string | null },
  options: PostedDateFilterOptions,
  now: Date = new Date(),
): boolean {
  if (!options.postedWithinDays || options.postedWithinDays <= 0) return true;
  if (!fact.postedDate) return !options.rejectUnknownDate;
  const posted = new Date(`${fact.postedDate}T00:00:00Z`);
  if (Number.isNaN(posted.getTime())) return !options.rejectUnknownDate;
  const ageDays = (now.getTime() - posted.getTime()) / (24 * 60 * 60 * 1000);
  return ageDays <= options.postedWithinDays;
}
