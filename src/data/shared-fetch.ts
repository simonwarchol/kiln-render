/**
 * Generic refcounted in-flight request coalescing with correct abort
 * semantics: the shared operation runs under its own AbortController, not
 * any single caller's signal, so cancelling one caller can't kill it for
 * others still waiting on it — it's only aborted once every caller has
 * released (refs reaches 0). If a caller is still interested when the shared
 * operation *does* get aborted (a race between a release and a new caller
 * arriving), it recurses into a fresh registration instead of running its own
 * standalone duplicate, so any other still-interested caller coalesces onto
 * the new shared operation too.
 *
 * Dependency-free so the concurrency logic can be unit-tested in isolation;
 * zarr-chunk-worker.ts shares chunk fetches through it. (Tying a shared
 * fetch to its first caller's signal instead cancels it for everyone when
 * that caller gives up, and the survivors then each fetch it again.)
 */
export class SharedFetchRegistry<T> {
  private entries = new Map<
    string,
    { promise: Promise<T>; refs: number; controller: AbortController }
  >();

  /**
   * Run `fetch(signal)` for `key`, coalescing concurrent callers for the same
   * key onto one shared invocation. `fetch` is only invoked when no shared
   * invocation is currently registered for `key`.
   */
  run(
    key: string,
    fetch: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted)
      return Promise.reject(new DOMException("Aborted", "AbortError"));

    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = fetch(controller.signal).finally(() => {
        // Guard: only clear if this entry is still the current one for the
        // key — a newer entry may have replaced it (re-registration below).
        if (this.entries.get(key)?.controller === controller)
          this.entries.delete(key);
      });
      entry = { promise, refs: 0, controller };
      this.entries.set(key, entry);
    }

    const current = entry;
    current.refs++;
    let released = false;
    const release = () => {
      if (released) return; // idempotent — settle and abort-listener both call this
      released = true;
      current.refs--;
      if (
        current.refs <= 0 &&
        this.entries.get(key)?.controller === current.controller
      ) {
        current.controller.abort();
      }
    };
    signal?.addEventListener("abort", release, { once: true });

    return current.promise.then(
      (result) => {
        release();
        return result;
      },
      (e: unknown) => {
        release();
        if (
          e instanceof DOMException &&
          e.name === "AbortError" &&
          !signal?.aborted
        ) {
          return this.run(key, fetch, signal);
        }
        throw e;
      },
    );
  }

  /** Number of keys with a currently in-flight shared fetch — for tests/diagnostics. */
  get size(): number {
    return this.entries.size;
  }
}
