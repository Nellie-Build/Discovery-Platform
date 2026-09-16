import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePolling } from './use-polling';

interface PolledRun { id: string; status: string }

describe('usePolling', () => {
  it('fetches immediately once enabled, and stops once stopWhen(result) is true', async () => {
    const fn = vi.fn<() => Promise<PolledRun>>().mockResolvedValue({ id: 'a', status: 'succeeded' });
    const { result } = renderHook(() => usePolling(fn, { enabled: true, intervalMs: 50, key: 'a', stopWhen: (r: PolledRun) => r.status === 'succeeded' }));
    await waitFor(() => expect(result.current.data).toEqual({ id: 'a', status: 'succeeded' }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a key change while enabled stays continuously true restarts polling for the new target — the exact regression: starting a second run before enabled ever toggled back to false must not keep showing the first run\'s data forever', async () => {
    const runA: PolledRun = { id: 'runA', status: 'succeeded' };
    const runB: PolledRun = { id: 'runB', status: 'succeeded' };
    const fn = vi.fn<() => Promise<PolledRun>>().mockImplementation(async () => (fn.mock.calls.length === 1 ? runA : runB));
    const { result, rerender } = renderHook(
      ({ key }) => usePolling(fn, { enabled: true, intervalMs: 50, key, stopWhen: (r: PolledRun) => r.status === 'succeeded' }),
      { initialProps: { key: 'runA' } },
    );
    await waitFor(() => expect(result.current.data).toEqual(runA));

    // enabled never changes (stays true the whole time) — only the key changes, exactly like
    // activeRunId changing from one run id straight to another without passing through null.
    rerender({ key: 'runB' });
    await waitFor(() => expect(result.current.data).toEqual(runB));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a key change clears the previous target\'s data immediately, never attributing stale data to the new target while the new poll is in flight', async () => {
    const runA: PolledRun = { id: 'runA', status: 'succeeded' };
    let resolveRunB!: (value: PolledRun) => void;
    const fn = vi.fn<() => Promise<PolledRun>>()
      .mockResolvedValueOnce(runA)
      .mockImplementationOnce(() => new Promise<PolledRun>(resolve => { resolveRunB = resolve; }));
    const { result, rerender } = renderHook(
      ({ key }) => usePolling(fn, { enabled: true, intervalMs: 50, key, stopWhen: (r: PolledRun) => r.status === 'succeeded' }),
      { initialProps: { key: 'runA' } },
    );
    await waitFor(() => expect(result.current.data).toEqual(runA));

    rerender({ key: 'runB' });
    expect(result.current.data).toBeNull(); // never runA while runB's own fetch is still pending

    resolveRunB({ id: 'runB', status: 'succeeded' });
    await waitFor(() => expect(result.current.data).toEqual({ id: 'runB', status: 'succeeded' }));
  });

  it('never fetches at all while disabled', async () => {
    const fn = vi.fn<() => Promise<PolledRun>>().mockResolvedValue({ id: 'a', status: 'succeeded' });
    renderHook(() => usePolling(fn, { enabled: false, intervalMs: 50, key: 'a' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fn).not.toHaveBeenCalled();
  });
});
