import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@discovery-platform/client';

/**
 * Polls `fn` every `intervalMs` while `enabled` is true — used for run status (see item 11 of
 * the fase 2.2 brief: polling is deliberately simpler than a websocket for this phase). Stops
 * automatically once `stopWhen(result)` returns true (e.g. the run reached "succeeded"/"failed").
 */
export function usePolling<T>(fn: () => Promise<T>, options: { intervalMs: number; enabled: boolean; stopWhen?: (value: T) => boolean }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const stopWhenRef = useRef(options.stopWhen);
  stopWhenRef.current = options.stopWhen;

  useEffect(() => {
    if (!options.enabled) return;
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
  }, [options.enabled, options.intervalMs]);

  return { data, error };
}
