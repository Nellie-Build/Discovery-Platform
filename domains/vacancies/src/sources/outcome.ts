import type { VacancySourceMeta } from './types.js';

export function sourceFailure(error: unknown): { errorType: string; error: string; retryAfterMs?: number } {
  const value = error as { message?: string; name?: string; status?: number; response?: { status?: number; headers?: Record<string, string> } };
  const text = `${value?.name ?? ''} ${value?.message ?? String(error)}`;
  const status = value?.status ?? value?.response?.status;
  const errorType = status === 429 || /429|rate.?limit/i.test(text) ? 'rate_limited'
    : /timeout|timed out|aborterror/i.test(text) ? 'timeout'
    : /ECONN|ETIMEDOUT|EAI_AGAIN|network|fetch failed|socket/i.test(text) ? 'network'
    : 'provider_error';
  const retryAfter = value?.response?.headers?.['retry-after'];
  const delay = retryAfter ? Number(retryAfter) * 1000 : NaN;
  const retryAfterMs = retryAfter ? Math.max(0, Number.isFinite(delay) ? delay : Date.parse(retryAfter) - Date.now()) : undefined;
  // Do not retain provider exception text: it can contain credentials, request headers or URLs.
  return { errorType, error: errorType === 'rate_limited' ? 'HTTP 429: bron tijdelijk begrensd.'
    : errorType === 'timeout' ? 'Bron reageerde niet binnen de tijdslimiet.'
    : errorType === 'network' ? 'Tijdelijke netwerkfout bij de bron.' : 'Bron kon de zoekopdracht niet uitvoeren.',
    ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}) };
}

export function summarizeSources(sources: VacancySourceMeta[]) {
  const requested = sources.filter(s => s.status !== 'user_disabled');
  const available = requested.filter(s => !['not_configured', 'unavailable'].includes(s.status));
  const succeeded = available.filter(s => ['ok', 'empty', 'partial'].includes(s.status));
  const failed = available.filter(s => ['error', 'rate_limited', 'partial'].includes(s.status));
  const status = succeeded.length === 0 ? 'failed'
    : failed.length ? 'partial' : 'succeeded';
  const stopReason = succeeded.length === 0
    ? failed.length === 0 ? 'source_unavailable' : failed.every(s => s.status === 'rate_limited' || s.errorType === 'rate_limited') ? 'source_rate_limited' : 'all_sources_failed'
    : failed.some(s => s.status === 'rate_limited' || s.errorType === 'rate_limited') ? 'source_rate_limited'
    : failed.length ? 'source_unavailable' : null;
  return { status, stopReason, sourcesRequested: requested.length, sourcesAvailable: available.length,
    sourcesSucceeded: succeeded.length, sourcesFailed: failed.length } as const;
}
