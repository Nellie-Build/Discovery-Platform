import { SourceError } from '@discovery-platform/core';

/**
 * One polite JSON-over-HTTP client for a tender source: one request at a time with a minimum pause between them, a
 * timeout per request, and a few retries for transient failures only (429, 5xx, timeouts, network errors; a numeric
 * Retry-After is honoured, capped at 30 s). Every failure is a `SourceError` with a stable code.
 */
export interface JsonClientOptions {
  /** Used in error messages ("TenderNed answered HTTP 503."). */
  serviceName: string;
  fetch?: typeof fetch;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxBodyChars?: number;
}
export interface JsonRequest { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }
export interface JsonClient {
  request(url: string, options?: JsonRequest): Promise<unknown>;
  stats(): { requests: number; retries: number };
}

export function createJsonClient(options: JsonClientOptions): JsonClient {
  const name = options.serviceName;
  const doFetch = options.fetch ?? fetch;
  const clock = options.clock ?? { now: Date.now, sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const minIntervalMs = options.minIntervalMs ?? 300;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRetries = options.maxRetries ?? 2;
  const maxBodyChars = options.maxBodyChars ?? 5_000_000;
  const stats = { requests: 0, retries: 0 };
  let lastRequestAt = -Infinity;

  async function backoff(attempt: number, retryAfter: string | null) {
    if (attempt >= maxRetries) return;
    const seconds = retryAfter && /^\d{1,3}$/.test(retryAfter) ? Math.min(30, Number(retryAfter)) : attempt + 1;
    await clock.sleep(seconds * 1000);
  }

  return {
    stats: () => ({ ...stats }),
    async request(url, request = {}) {
      let lastError: SourceError | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (request.signal?.aborted) throw new SourceError('The request was aborted.', 'aborted');
        const wait = lastRequestAt + minIntervalMs - clock.now();
        if (wait > 0) await clock.sleep(wait);
        lastRequestAt = clock.now();
        stats.requests++;
        if (attempt > 0) stats.retries++;
        let response: Response;
        try {
          const timeout = AbortSignal.timeout(timeoutMs);
          response = await doFetch(url, {
            method: request.method ?? 'GET',
            headers: { accept: 'application/json', 'user-agent': 'DiscoveryCoreBot/1.0', ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}) },
            ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
            signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
          });
        } catch (error) {
          if (request.signal?.aborted) throw new SourceError('The request was aborted.', 'aborted');
          const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
          lastError = new SourceError(timedOut ? `${name} did not answer within ${timeoutMs} ms.` : `${name} could not be reached.`, timedOut ? 'timeout' : 'http', true);
          await backoff(attempt, null);
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          lastError = new SourceError(`${name} answered HTTP ${response.status}.`, 'http', true, response.status);
          await backoff(attempt, response.headers.get('retry-after'));
          continue;
        }
        if (!response.ok) throw new SourceError(`${name} answered HTTP ${response.status}.`, 'http', false, response.status);
        const text = await response.text();
        if (text.length > maxBodyChars) throw new SourceError(`${name} returned an unexpectedly large response.`, 'invalid_response');
        try { return JSON.parse(text); } catch { throw new SourceError(`${name} did not return valid JSON.`, 'invalid_response'); }
      }
      throw lastError ?? new SourceError(`${name} could not be reached.`, 'http', true);
    },
  };
}
