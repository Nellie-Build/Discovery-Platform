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
}
export interface CrawlCandidate extends CandidateEvidence {
  canonicalUrl: string;
  candidateScore: number;
  candidateReasons: string[];
  classification: CandidateRank['classification'];
}

/** Bounded, stable priority queue. Better new evidence promotes an existing URL; a better
 * newcomer replaces the worst waiting URL when full. No URL is processed twice. */
export class CandidateQueue {
  private pending = new Map<string, CrawlCandidate>();
  limitReached = false;
  constructor(private readonly capacity: number) {}
  offer(candidate: CrawlCandidate): boolean {
    const previous = this.pending.get(candidate.canonicalUrl);
    if (previous) {
      if (candidate.candidateScore > previous.candidateScore) this.pending.set(candidate.canonicalUrl, candidate);
      return true;
    }
    if (this.pending.size >= this.capacity) {
      this.limitReached = true;
      const worst = [...this.pending.values()].reduce((a, b) => a.candidateScore <= b.candidateScore ? a : b);
      if (worst.candidateScore >= candidate.candidateScore) return false;
      this.pending.delete(worst.canonicalUrl);
    }
    this.pending.set(candidate.canonicalUrl, candidate);
    return true;
  }
  take(visited: Set<string>): CrawlCandidate | undefined {
    for (const url of visited) this.pending.delete(url);
    let best: CrawlCandidate | undefined;
    for (const candidate of this.pending.values()) {
      if (!best || candidate.candidateScore > best.candidateScore) best = candidate;
    }
    if (best) this.pending.delete(best.canonicalUrl);
    return best;
  }
  remaining(visited: Set<string>): number {
    return [...this.pending.keys()].filter(url => !visited.has(url)).length;
  }
  get size(): number { return this.pending.size; }
}
