/** Domain-neutral evidence. Scores are higher-first; the domain supplies classification. */
export interface CandidateEvidence {
  url: string;
  source: 'requested' | 'homepage' | 'sitemap' | 'link' | 'listing' | 'pagination';
  label: string;
  discoveredFrom: string;
}
export interface CandidateRank {
  score: number;
  reasons: string[];
  classification: 'detail' | 'listing' | 'general' | 'pagination';
  /** Optional, supplied by the domain: two different URLs with the same key are the same page/record
   * seen through different addresses (a language variant, a tracking-free alias). The crawler processes
   * at most one of them; it never interprets the key. */
  dedupeKey?: string;
}
export interface CrawlCandidate extends CandidateEvidence {
  canonicalUrl: string;
  candidateScore: number;
  candidateReasons: string[];
  classification: CandidateRank['classification'];
}

/** Bounded, stable priority queue. Better new evidence promotes an existing URL; a better
 * newcomer replaces the worst waiting URL when full. No URL is processed twice.
 *
 * An optional identity (the domain's `dedupeKey`) additionally keeps different URLs of the same record
 * from being processed twice: while nothing has started, the best-scoring variant waits (the earlier one
 * on a tie); once a variant has been taken, its identity stays claimed, so a variant discovered later —
 * also while the first is still being fetched — is never queued. */
export class CandidateQueue {
  private pending = new Map<string, CrawlCandidate>();
  private identityOfUrl = new Map<string, string>();
  private urlOfIdentity = new Map<string, string>();
  private claimed = new Set<string>();
  limitReached = false;
  constructor(private readonly capacity: number) {}
  private remove(url: string) {
    this.pending.delete(url);
    const identity = this.identityOfUrl.get(url);
    if (identity !== undefined) { this.identityOfUrl.delete(url); if (this.urlOfIdentity.get(identity) === url) this.urlOfIdentity.delete(identity); }
  }
  offer(candidate: CrawlCandidate, identity?: string): boolean {
    const previous = this.pending.get(candidate.canonicalUrl);
    if (previous) {
      if (candidate.candidateScore > previous.candidateScore) this.pending.set(candidate.canonicalUrl, candidate);
      return true;
    }
    if (identity !== undefined) {
      if (this.claimed.has(identity)) return false;
      const other = this.urlOfIdentity.get(identity);
      if (other !== undefined) {
        if (this.pending.get(other)!.candidateScore >= candidate.candidateScore) return false;
        this.remove(other);
      }
    }
    if (this.pending.size >= this.capacity) {
      this.limitReached = true;
      const worst = [...this.pending.values()].reduce((a, b) => a.candidateScore <= b.candidateScore ? a : b);
      if (worst.candidateScore >= candidate.candidateScore) return false;
      this.remove(worst.canonicalUrl);
    }
    this.pending.set(candidate.canonicalUrl, candidate);
    if (identity !== undefined) { this.identityOfUrl.set(candidate.canonicalUrl, identity); this.urlOfIdentity.set(identity, candidate.canonicalUrl); }
    return true;
  }
  private claim(url: string) {
    const identity = this.identityOfUrl.get(url);
    if (identity !== undefined) this.claimed.add(identity);
    this.remove(url);
  }
  take(visited: Set<string>): CrawlCandidate | undefined {
    for (const url of visited) if (this.pending.has(url)) this.claim(url);
    let best: CrawlCandidate | undefined;
    for (const candidate of this.pending.values()) {
      if (!best || candidate.candidateScore > best.candidateScore) best = candidate;
    }
    if (best) this.claim(best.canonicalUrl);
    return best;
  }
  remaining(visited: Set<string>): number {
    return [...this.pending.keys()].filter(url => !visited.has(url)).length;
  }
  get size(): number { return this.pending.size; }
}
