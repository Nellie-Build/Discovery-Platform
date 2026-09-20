/** What `buildRecordsFromFacts` decided for one fact that passed the relevance stage. */
export type FactOutcome = 'date_rejected' | 'duplicate_in_run' | 'already_known' | 'new';

/** Every candidate ends in exactly one of the last eight buckets, so for any bucket (the run as a
 * whole or a single provider):
 *
 *   discovered + multiRecordExtra =
 *     notProcessed + noUsableData + rejectedByRelevance + rejectedByDate
 *     + duplicatesInRun + alreadyKnown + cutByTarget + newRecords
 *
 * The buckets never overlap. `relevant` is a subtotal (everything that survived the relevance
 * stage: rejectedByDate + duplicatesInRun + alreadyKnown + cutByTarget + newRecords), not an
 * extra bucket. `multiRecordExtra` is only non-zero when one candidate page yielded more than
 * one vacancy. */
export interface BreakdownBucket {
  discovered: number;
  notProcessed: number;
  noUsableData: number;
  rejectedByRelevance: number;
  relevant: number;
  rejectedByDate: number;
  duplicatesInRun: number;
  alreadyKnown: number;
  cutByTarget: number;
  newRecords: number;
  multiRecordExtra: number;
}

export interface SiteProgress { discovered: number; attempted: number; withData: number }

export interface RunBreakdown extends BreakdownBucket {
  /** Extra info, not a bucket: known records that were stored again (only with onlyNewRecords off). */
  reseenRecords: number;
  byProvider: Record<string, BreakdownBucket>;
}

const emptyBucket = (): BreakdownBucket => ({
  discovered: 0, notProcessed: 0, noUsableData: 0, rejectedByRelevance: 0, relevant: 0, rejectedByDate: 0,
  duplicatesInRun: 0, alreadyKnown: 0, cutByTarget: 0, newRecords: 0, multiRecordExtra: 0,
});

/** Generic over the fact type: only *-adapter.ts files may import a domain module (see
 * tests/dependency-boundary.test.mjs), and facts are only ever compared by identity here. */
export function computeBranchBreakdown<F extends object>(input: {
  perSite: Map<string, SiteProgress>;
  freshFacts: F[];
  factSite: Map<F, string>;
  relevant: Set<F>;
  outcomes: Map<F, FactOutcome>;
  /** Facts whose new record was actually kept (not cut off by targetRecords). */
  stored: Set<F>;
  reseenRecords: number;
}): RunBreakdown {
  const byProvider: Record<string, BreakdownBucket> = {};
  const factsPerSite = new Map<string, number>();
  for (const [site, progress] of input.perSite) {
    const bucket = emptyBucket();
    bucket.discovered = progress.discovered;
    bucket.notProcessed = Math.max(0, progress.discovered - progress.attempted);
    bucket.noUsableData = Math.max(0, progress.attempted - progress.withData);
    byProvider[site] = bucket;
  }
  for (const fact of input.freshFacts) {
    const site = input.factSite.get(fact) ?? 'unknown';
    factsPerSite.set(site, (factsPerSite.get(site) ?? 0) + 1);
    const bucket = byProvider[site] ??= emptyBucket();
    if (!input.relevant.has(fact)) { bucket.rejectedByRelevance++; continue; }
    bucket.relevant++;
    const outcome = input.outcomes.get(fact);
    if (outcome === 'date_rejected') bucket.rejectedByDate++;
    else if (outcome === 'duplicate_in_run') bucket.duplicatesInRun++;
    else if (outcome === 'already_known') bucket.alreadyKnown++;
    else if (input.stored.has(fact)) bucket.newRecords++;
    else bucket.cutByTarget++;
  }
  for (const [site, bucket] of Object.entries(byProvider)) {
    const progress = input.perSite.get(site);
    bucket.multiRecordExtra = Math.max(0, (factsPerSite.get(site) ?? 0) - (progress?.withData ?? 0));
  }
  const total = emptyBucket();
  for (const bucket of Object.values(byProvider)) for (const key of Object.keys(total) as (keyof BreakdownBucket)[]) total[key] += bucket[key];
  return { ...total, reseenRecords: input.reseenRecords, byProvider };
}
