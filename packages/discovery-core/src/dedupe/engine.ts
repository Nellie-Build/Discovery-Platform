/**
 * A domain-neutral "block records by a shared signal, sum matched signal weights, clamp,
 * decide" primitive — the exact counterpart to ../scoring/engine.ts, but for pairwise duplicate
 * detection instead of single-record scoring. This package has no opinion on what a "signal" is
 * (a shared website domain, a shared phone number, a filled-in job title): a domain module
 * supplies its own signal definitions, this file only blocks/pairs/sums/decides. See
 * domains/vacancies/src/dedupe/matching.ts (source URL and company/title/location signals) for
 * a real signal set built on this exact `findDuplicateCandidates()`, and an accommodation-domain
 * module's exact-key + distance signals (same website domain, phone, name+city, coordinates) as
 * a second, completely different real example of the same engine in use.
 */

export type DedupeDecision = 'strong_match' | 'possible_duplicate' | 'none';

export interface DedupeSignalMatch {
  id: string;
  points: number;
}

export interface DedupeThresholds {
  /** score >= strongMatch: a domain typically treats this as safe to act on automatically
   * (auto-merge, say; another domain might just flag it more prominently instead). */
  strongMatch: number;
  /** strongMatch > score >= possibleDuplicate: worth flagging for human review. Below: ignore. */
  possibleDuplicate: number;
}

export interface ScoreMatchOptions {
  /** Defaults to 0. */
  min?: number;
  /** Defaults to 100. */
  max?: number;
  thresholds: DedupeThresholds;
}

export interface DedupeResult {
  score: number;
  matchedSignals: string[];
  decision: DedupeDecision;
}

/** Sums the points of every signal that matched, clamps, and turns that into a decision against
 * the given thresholds — no idea what any signal id means, only that it fired. */
export function scoreMatch(matches: DedupeSignalMatch[], options: ScoreMatchOptions): DedupeResult {
  const min = options.min ?? 0;
  const max = options.max ?? 100;
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const score = clamp(matches.reduce((sum, m) => sum + m.points, 0));
  const decision: DedupeDecision = score >= options.thresholds.strongMatch ? 'strong_match'
    : score >= options.thresholds.possibleDuplicate ? 'possible_duplicate'
    : 'none';
  return { score, matchedSignals: matches.map(m => m.id), decision };
}

/** Great-circle distance in meters between two coordinates (haversine formula). Pure geometry —
 * no domain knowledge, usable by any record shape that has a latitude/longitude. */
export function haversineDistanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const earthRadiusMeters = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude), lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** A signal that fires for every pair of records sharing the same non-null key — e.g. the same
 * normalized phone number, or the same normalized "company|title|location" string. Blocking by
 * key keeps this O(n) instead of an O(n^2) pairwise scan; records where `keyOf` returns null
 * (e.g. no phone number at all) never match anything via this signal. */
export interface ExactKeySignal<T> {
  id: string;
  points: number;
  keyOf: (record: T) => string | null;
}

/** A fuzzy/distance signal that fires for every pair of records within `thresholdMeters` of each
 * other, using grid-bucketed nearest-neighbor search (still far from O(n^2)). Records where
 * `coordsOf` returns null (no known location) never match anything via this signal. */
export interface DistanceSignal<T> {
  id: string;
  points: number;
  thresholdMeters: number;
  coordsOf: (record: T) => { latitude: number; longitude: number } | null;
}

export interface DedupeCandidate<T> {
  recordA: T;
  recordB: T;
  matchedSignals: string[];
  score: number;
  decision: DedupeDecision;
}

export interface FindDuplicateCandidatesOptions<T> {
  idOf: (record: T) => string;
  exactSignals?: ExactKeySignal<T>[];
  distanceSignals?: DistanceSignal<T>[];
  thresholds: DedupeThresholds;
  min?: number;
  max?: number;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  return groups;
}

function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

/** Grid-bucket by coordinates (cell size well above any realistic threshold) so only nearby
 * records get an exact distance check. */
function findPairsWithinDistance<T>(
  records: T[], idOf: (record: T) => string,
  coordsOf: (record: T) => { latitude: number; longitude: number } | null, thresholdMeters: number,
): [T, T][] {
  const withCoords = records
    .map(record => ({ record, coords: coordsOf(record) }))
    .filter((x): x is { record: T; coords: { latitude: number; longitude: number } } => x.coords !== null);
  const cellSizeDegrees = 0.01; // ~1.1km at the equator — comfortably larger than any realistic threshold
  const cellOf = (coords: { latitude: number; longitude: number }) =>
    [Math.floor(coords.latitude / cellSizeDegrees), Math.floor(coords.longitude / cellSizeDegrees)] as const;
  const cells = groupBy(withCoords, x => cellOf(x.coords).join(':'));

  const pairs: [T, T][] = [];
  const seen = new Set<string>();
  for (const item of withCoords) {
    const [cellLat, cellLon] = cellOf(item.coords);
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        for (const other of cells.get(`${cellLat + dLat}:${cellLon + dLon}`) ?? []) {
          if (idOf(other.record) === idOf(item.record)) continue;
          const key = pairKey(idOf(item.record), idOf(other.record));
          if (seen.has(key)) continue;
          seen.add(key);
          if (haversineDistanceMeters(item.coords, other.coords) <= thresholdMeters) pairs.push([item.record, other.record]);
        }
      }
    }
  }
  return pairs;
}

/**
 * Finds duplicate candidates across all records using blocking (grouping by each exact-key
 * signal, grid-bucketing for each distance signal) rather than a full pairwise scan, so this
 * stays fast well beyond a few thousand records. Returns only pairs that reach at least
 * "possible duplicate", sorted by score descending. Every signal's meaning (which field, what
 * threshold, what it is worth) is supplied by the caller — this function has no domain
 * knowledge of its own.
 */
export function findDuplicateCandidates<T>(records: T[], options: FindDuplicateCandidatesOptions<T>): DedupeCandidate<T>[] {
  const { idOf, exactSignals = [], distanceSignals = [], thresholds, min, max } = options;
  const byId = new Map(records.map(record => [idOf(record), record]));
  const pairMatches = new Map<string, DedupeSignalMatch[]>();
  const mark = (a: T, b: T, match: DedupeSignalMatch) => {
    const key = pairKey(idOf(a), idOf(b));
    const matches = pairMatches.get(key) ?? [];
    matches.push(match);
    pairMatches.set(key, matches);
  };

  for (const signal of exactSignals) {
    for (const group of groupBy(records, signal.keyOf).values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) mark(group[i], group[j], { id: signal.id, points: signal.points });
      }
    }
  }
  for (const signal of distanceSignals) {
    for (const [a, b] of findPairsWithinDistance(records, idOf, signal.coordsOf, signal.thresholdMeters)) {
      mark(a, b, { id: signal.id, points: signal.points });
    }
  }

  const candidates: DedupeCandidate<T>[] = [];
  for (const [key, matches] of pairMatches) {
    const result = scoreMatch(matches, { min, max, thresholds });
    if (result.decision === 'none') continue;
    const [idA, idB] = key.split(':');
    candidates.push({ recordA: byId.get(idA)!, recordB: byId.get(idB)!, matchedSignals: result.matchedSignals, score: result.score, decision: result.decision });
  }
  return candidates.sort((a, b) => b.score - a.score);
}
