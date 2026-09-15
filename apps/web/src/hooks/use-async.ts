import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@discovery-platform/client';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Runs `fn` whenever any of `deps` changes, exposing loading/error/data — the one place every
 * page in this app gets its "is this still loading / did this fail" state from, so no screen
 * reinvents its own ad hoc fetch-in-useEffect logic. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fnRef.current()
      .then(result => { if (!cancelled) setData(result); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Something went wrong.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  const refetch = useCallback(() => setVersion(v => v + 1), []);
  return { data, loading, error, refetch };
}
