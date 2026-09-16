import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@discovery-platform/client';

/**
 * Polls `fn` every `intervalMs` while `enabled` is true — used for run status (see item 11 of
 * the fase 2.2 brief: polling is deliberately simpler than a websocket for this phase). Stops
 * automatically once `stopWhen(result)` returns true (e.g. the run reached "succeeded"/"failed").
 *
 * `key` identifies *what* is being polled (e.g. a run id) — pass it whenever the caller can
 * re-enable polling for a genuinely different target while `enabled` itself stays continuously
 * true across that change (starting a second run before some earlier effect got a chance to
 * toggle `enabled` back to false is exactly this case — see project-detail.tsx's own history).
 * Without a `key`, this hook only ever restarts when `enabled` itself flips, so a same-`enabled`
 * target swap would silently keep polling (and displaying) the *previous* target forever.
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  options: { intervalMs: number; enabled: boolean; key?: string | number | null; stopWhen?: (value: T) => boolean },
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const stopWhenRef = useRef(options.stopWhen);
  stopWhenRef.current = options.stopWhen;

  useEffect(() => {
    if (!options.enabled) return;
    // A new *active* target never carries over a previous target's own last result — but
    // disabling polling (enabled -> false, e.g. once a run reaches a terminal state) must
    // never clear it: the caller keeps reading `data` as "the last thing this run resolved
    // to" after polling stops, exactly like project-detail.tsx's own `latestRun` does.
    setData(null);
    setError(null);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const result = await fnRef.current();
        if (cancelled) return;
        setData(result);
        setError(null);
        if (stopWhenRef.current?.(result)) return;
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Something went wrong.');
        return; // stop polling on error rather than hammering a failing endpoint
      }
      if (!cancelled) timer = setTimeout(tick, options.intervalMs);
    }
    tick();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, options.intervalMs, options.key]);

  return { data, error };
}
