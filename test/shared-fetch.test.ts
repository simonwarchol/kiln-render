import { describe, it, expect, vi } from 'vitest';
import { SharedFetchRegistry } from '../src/data/shared-fetch.js';

describe('SharedFetchRegistry', () => {
  it('coalesces concurrent callers for the same key into one fetch invocation', async () => {
    const registry = new SharedFetchRegistry<string>();
    let resolve!: (v: string) => void;
    const pending = new Promise<string>(r => { resolve = r; });
    const fetchFn = vi.fn(() => pending);

    const p1 = registry.run('k', fetchFn);
    const p2 = registry.run('k', fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    resolve('value');
    await expect(p1).resolves.toBe('value');
    await expect(p2).resolves.toBe('value');
  });

  it('does not share fetches across different keys', async () => {
    const registry = new SharedFetchRegistry<string>();
    const fetchA = vi.fn(() => Promise.resolve('a'));
    const fetchB = vi.fn(() => Promise.resolve('b'));

    await expect(registry.run('key-a', fetchA)).resolves.toBe('a');
    await expect(registry.run('key-b', fetchB)).resolves.toBe('b');
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });

  it('cleans up the registry entry after the shared fetch settles', async () => {
    const registry = new SharedFetchRegistry<string>();
    await registry.run('k', () => Promise.resolve('value'));
    expect(registry.size).toBe(0);
  });

  it('rejects immediately without calling fetch if the caller signal is already aborted', async () => {
    const registry = new SharedFetchRegistry<string>();
    const fetchFn = vi.fn(() => Promise.resolve('value'));
    const controller = new AbortController();
    controller.abort();

    await expect(registry.run('k', fetchFn, controller.signal)).rejects.toThrow(/Aborted/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // --- The core fix (bug B4): cancelling ONE caller must not kill the shared
  // fetch for OTHER callers still waiting on it. ---

  it('does not abort the underlying fetch when only one of several callers cancels', async () => {
    const registry = new SharedFetchRegistry<string>();
    let capturedSignal: AbortSignal | undefined;
    let resolve!: (v: string) => void;
    const fetchFn = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<string>(r => { resolve = r; });
    });

    const controllerA = new AbortController();
    const pA = registry.run('k', fetchFn, controllerA.signal);
    const pB = registry.run('k', fetchFn); // no signal — never cancels

    controllerA.abort(); // A cancels; B is still waiting

    // The shared/internal fetch must still be alive — B still needs it.
    expect(capturedSignal!.aborted).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolve('value');
    // Both settle with the successful result. A's cancellation didn't kill
    // the shared fetch (B still needed it), so there's nothing to force-reject
    // for A either — a caller that needs to discard cancelled work does so via
    // its own outer abort check (see assembleBrick in zarr-chunk-worker.ts).
    await expect(pA).resolves.toBe('value');
    await expect(pB).resolves.toBe('value');
    expect(fetchFn).toHaveBeenCalledTimes(1); // still just the one shared fetch
  });

  it('aborts the underlying fetch once every caller has released', async () => {
    const registry = new SharedFetchRegistry<string>();
    let capturedSignal: AbortSignal | undefined;
    const fetchFn = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const pA = registry.run('k', fetchFn, controllerA.signal);
    const pB = registry.run('k', fetchFn, controllerB.signal);

    controllerA.abort();
    expect(capturedSignal!.aborted).toBe(false); // B still holds a ref

    controllerB.abort(); // last ref released
    expect(capturedSignal!.aborted).toBe(true);

    await expect(pA).rejects.toThrow(/Aborted/);
    await expect(pB).rejects.toThrow(/Aborted/);
  });

  it('is idempotent if a caller settles and its abort listener both fire', async () => {
    const registry = new SharedFetchRegistry<string>();
    const controller = new AbortController();
    const p = registry.run('k', () => Promise.resolve('value'), controller.signal);
    await expect(p).resolves.toBe('value');
    // Aborting after settling must not throw or double-release.
    expect(() => controller.abort()).not.toThrow();
  });

  it('re-registers for a still-interested caller that lands in the abort/cleanup race window', async () => {
    const registry = new SharedFetchRegistry<string>();
    const pendingResolvers: Array<(v: string) => void> = [];
    const fetchFn = vi.fn((signal: AbortSignal) => {
      return new Promise<string>((resolve, reject) => {
        pendingResolvers.push(resolve);
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const controllerA = new AbortController();
    const pA = registry.run('k', fetchFn, controllerA.signal); // refs 0→1
    controllerA.abort(); // refs 1→0, shared fetch aborts synchronously (entry not yet cleaned up)
    const pB = registry.run('k', fetchFn); // lands on the still-present (dying) entry

    await pA.catch(() => {}); // let A's rejection — and B's reaction to it — settle

    // B's own signal was never aborted, so it must recurse onto a fresh fetch
    // rather than reject alongside A.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    pendingResolvers[1]!('value-for-b');
    await expect(pB).resolves.toBe('value-for-b');
    await expect(pA).rejects.toThrow(/Aborted/);
  });
});
