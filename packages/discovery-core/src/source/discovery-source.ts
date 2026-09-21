/**
 * A domain-neutral way to pull records from somewhere that is not a website crawl: a JSON API, a
 * feed, or (as one implementation among others) the website crawler. The core knows nothing about
 * what the items are, which filters a source understands, or what a cursor means — it only defines
 * the shape of one batch and a bounded loop around it. A domain module (or an application adapter)
 * supplies the actual source and maps `raw` to its own facts.
 */
export type DiscoverySourceKind = 'api' | 'feed' | 'website';

/** One thing a source returned: only generic provenance plus the source's own payload. */
export interface SourceItem<TRaw = unknown> {
  /** The source's own identifier for this item (unique within one source). */
  externalId: string;
  sourceUrl: string;
  /** ISO 8601 time at which the item was fetched. */
  fetchedAt: string;
  raw: TRaw;
}

export interface FetchBatchRequest {
  /** Opaque, produced by the same source's previous batch; null starts a new walk. */
  cursor: string | null;
  /** Source-specific, validated by the source itself. */
  filters: Record<string, unknown>;
  /** How many items one batch may return at most; a source that pages by itself uses it as the page size when a walk starts. */
  limit: number;
  signal?: AbortSignal;
}

export interface FetchBatchResult<TRaw = unknown> {
  items: SourceItem<TRaw>[];
  /** Resume point after this batch; null when there is nothing more to fetch. */
  nextCursor: string | null;
  /** True when this batch was the last one for these filters. */
  exhausted: boolean;
}

export interface DiscoverySource<TRaw = unknown> {
  readonly id: string;
  readonly kind: DiscoverySourceKind;
  fetchBatch(request: FetchBatchRequest): Promise<FetchBatchResult<TRaw>>;
}

export type SourceErrorCode = 'timeout' | 'http' | 'invalid_response' | 'invalid_filters' | 'aborted';

/** A failure of a source, with a stable code the caller can report; `retryable` says whether trying again may help. */
export class SourceError extends Error {
  constructor(message: string, readonly code: SourceErrorCode, readonly retryable = false, readonly status?: number) {
    super(message);
    this.name = 'SourceError';
  }
}

export type CollectStopReason = 'exhausted' | 'item_limit' | 'batch_limit' | 'time_limit' | 'no_progress';

export interface CollectOptions {
  filters?: Record<string, unknown>;
  cursor?: string | null;
  /** Requested batch size (the `limit` handed to the source). */
  batchSize: number;
  /** Stop once this many items were collected. */
  maxItems: number;
  maxBatches?: number;
  /** Stop starting new batches after this much time. */
  maxDurationMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface CollectResult<TRaw = unknown> {
  items: SourceItem<TRaw>[];
  /** Where a later run can continue without losing an item (the cursor before a batch that was cut short). */
  nextCursor: string | null;
  exhausted: boolean;
  batches: number;
  stopReason: CollectStopReason;
}

/**
 * Walks a source batch by batch inside hard limits (items, batches, time). Never loops without
 * progress: a batch that returns no items, is not the last one, and does not move the cursor ends
 * the walk. A source must honour `limit`; more items than requested is an invalid response.
 */
export async function collectFromSource<TRaw>(source: DiscoverySource<TRaw>, options: CollectOptions): Promise<CollectResult<TRaw>> {
  const now = options.now ?? Date.now;
  const start = now();
  const maxItems = Math.max(1, Math.floor(options.maxItems));
  const batchSize = Math.max(1, Math.floor(options.batchSize));
  const maxBatches = Math.max(1, Math.floor(options.maxBatches ?? 1000));
  const items: SourceItem<TRaw>[] = [];
  let cursor: string | null = options.cursor ?? null;
  let batches = 0;
  while (true) {
    if (items.length >= maxItems) return { items, nextCursor: cursor, exhausted: false, batches, stopReason: 'item_limit' };
    if (batches >= maxBatches) return { items, nextCursor: cursor, exhausted: false, batches, stopReason: 'batch_limit' };
    if (options.maxDurationMs !== undefined && now() - start >= options.maxDurationMs) return { items, nextCursor: cursor, exhausted: false, batches, stopReason: 'time_limit' };
    const result = await source.fetchBatch({ cursor, filters: options.filters ?? {}, limit: batchSize, signal: options.signal });
    batches++;
    if (result.items.length > batchSize) throw new SourceError(`Source "${source.id}" returned more items than the requested limit.`, 'invalid_response');
    const room = maxItems - items.length;
    if (result.items.length > room) {
      // Cut short: keep what fits and resume from before this batch, so nothing is skipped later.
      items.push(...result.items.slice(0, room));
      return { items, nextCursor: cursor, exhausted: false, batches, stopReason: 'item_limit' };
    }
    items.push(...result.items);
    if (result.exhausted) return { items, nextCursor: null, exhausted: true, batches, stopReason: 'exhausted' };
    if (result.items.length === 0 && result.nextCursor === cursor) return { items, nextCursor: cursor, exhausted: false, batches, stopReason: 'no_progress' };
    cursor = result.nextCursor;
  }
}
