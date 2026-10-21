/**
 * Byte sources for the HDF5 reader: HTTP Range (fetch), Blob/File, and a
 * page-cache wrapper used for metadata reads.
 */

export interface RangeSource {
  /** Read exactly `length` bytes at `offset` (may return fewer only at EOF). */
  read(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  /** Bytes fetched / requests issued so far (for stats). */
  readonly stats: { bytes: number; requests: number };
}

export interface CacheStats {
  /** Bytes fetched from the underlying source (cache misses only). */
  bytes: number;
  /** Requests issued to the underlying source. */
  requests: number;
  /** Page lookups served from the cache (including in-flight pages). */
  hits: number;
  /** Pages fetched. */
  misses: number;
}

const EMPTY = new Uint8Array(0);

/**
 * fetch()-based Range source. Never issues HEAD and never reads Content-Range
 * (neither is reliably available cross-origin). A server answering a Range
 * request with 200 is rejected, since that would download the whole file.
 */
export function httpRangeSource(
  url: string,
  opts: { fetch?: typeof fetch } = {},
): RangeSource {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const stats = { bytes: 0, requests: 0 };
  return {
    stats,
    async read(offset, length, signal) {
      if (length <= 0) return EMPTY;
      stats.requests++;
      const res = await doFetch(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        signal,
      });
      if (res.status === 416) {
        // Requested range starts at/after EOF.
        await res.body?.cancel();
        return EMPTY;
      }
      if (res.status === 200) {
        await res.body?.cancel();
        throw new Error(
          `HDF5: server ignored the HTTP Range header (got 200 instead of 206) for ${url}; ` +
            "byte-range access is required",
        );
      }
      if (res.status !== 206) {
        await res.body?.cancel();
        throw new Error(
          `HDF5: HTTP ${res.status} ${res.statusText} reading bytes ${offset}+${length} of ${url}`,
        );
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      stats.bytes += buf.length;
      return buf.length > length ? buf.subarray(0, length) : buf;
    },
  };
}

/** Range source over a local Blob / File. */
export function blobRangeSource(blob: Blob): RangeSource {
  const stats = { bytes: 0, requests: 0 };
  return {
    stats,
    async read(offset, length) {
      if (length <= 0 || offset >= blob.size) return EMPTY;
      stats.requests++;
      const buf = new Uint8Array(
        await blob.slice(offset, offset + length).arrayBuffer(),
      );
      stats.bytes += buf.length;
      return buf;
    },
  };
}

export interface CachedRangeSourceOptions {
  /** Page size in bytes (default 64 KiB). */
  pageSize?: number;
  /** Max cached pages, LRU-evicted (default 512 = 32 MiB at 64 KiB pages). */
  maxPages?: number;
  /** Missing pages separated by at most this many cached pages are fetched in one request (default 2). */
  maxGapPages?: number;
  /** Upper bound on one coalesced request (default 8 MiB). */
  maxRequestBytes?: number;
}

interface Waiter {
  resolve: (page: Uint8Array) => void;
  reject: (err: unknown) => void;
}

/**
 * Metadata page cache: aligned pages, LRU, in-flight de-dup, and coalescing of
 * missing pages requested in the same tick into as few underlying reads as
 * possible. Returned arrays may alias cached pages — callers must not mutate.
 */
export function cachedRangeSource(
  src: RangeSource,
  opts: CachedRangeSourceOptions = {},
): RangeSource & { readonly stats: CacheStats } {
  const pageSize = opts.pageSize ?? 64 * 1024;
  const maxPages = Math.max(1, opts.maxPages ?? 512);
  const maxGap = opts.maxGapPages ?? 2;
  const maxRunPages = Math.max(
    1,
    Math.floor((opts.maxRequestBytes ?? 8 * 1024 * 1024) / pageSize),
  );
  const stats: CacheStats = { bytes: 0, requests: 0, hits: 0, misses: 0 };
  const pages = new Map<number, Promise<Uint8Array>>();
  let pending = new Map<number, Waiter>();
  let flushScheduled = false;

  function insert(i: number, p: Promise<Uint8Array>): void {
    pages.set(i, p);
    p.catch(() => {
      if (pages.get(i) === p) pages.delete(i);
    });
    while (pages.size > maxPages) {
      const oldest = pages.keys().next().value as number;
      pages.delete(oldest);
    }
  }

  function getPage(i: number): Promise<Uint8Array> {
    const hit = pages.get(i);
    if (hit) {
      stats.hits++;
      pages.delete(i);
      pages.set(i, hit);
      return hit;
    }
    stats.misses++;
    let waiter!: Waiter;
    const p = new Promise<Uint8Array>((resolve, reject) => {
      waiter = { resolve, reject };
    });
    pending.set(i, waiter);
    insert(i, p);
    if (!flushScheduled) {
      flushScheduled = true;
      // Defer one macrotask so concurrent readers (Promise.all over siblings)
      // get their misses coalesced into shared requests.
      setTimeout(flush, 0);
    }
    return p;
  }

  function flush(): void {
    flushScheduled = false;
    const batch = pending;
    pending = new Map();
    const idx = [...batch.keys()].sort((a, b) => a - b);
    let k = 0;
    while (k < idx.length) {
      const start = idx[k]!;
      let end = start;
      k++;
      while (
        k < idx.length &&
        idx[k]! - end - 1 <= maxGap &&
        idx[k]! - start < maxRunPages
      ) {
        end = idx[k]!;
        k++;
      }
      fetchRun(start, end, batch);
    }
  }

  function fetchRun(start: number, end: number, batch: Map<number, Waiter>) {
    const n = end - start + 1;
    stats.requests++;
    src.read(start * pageSize, n * pageSize).then(
      (buf) => {
        stats.bytes += buf.length;
        for (let i = start; i <= end; i++) {
          const lo = Math.min(buf.length, (i - start) * pageSize);
          const page = buf.subarray(lo, Math.min(buf.length, lo + pageSize));
          const w = batch.get(i);
          if (w) w.resolve(page);
          else if (!pages.has(i)) insert(i, Promise.resolve(page)); // gap page
        }
      },
      (err) => {
        for (let i = start; i <= end; i++) batch.get(i)?.reject(err);
      },
    );
  }

  return {
    stats,
    async read(offset, length) {
      if (length <= 0) return EMPTY;
      const first = Math.floor(offset / pageSize);
      const last = Math.floor((offset + length - 1) / pageSize);
      const ps: Promise<Uint8Array>[] = [];
      for (let i = first; i <= last; i++) ps.push(getPage(i));
      const bufs = await Promise.all(ps);
      const skip = offset - first * pageSize;
      if (bufs.length === 1) {
        const b = bufs[0]!;
        return b.subarray(Math.min(skip, b.length), skip + length);
      }
      const out = new Uint8Array(length);
      let n = 0;
      for (let j = 0; j < bufs.length; j++) {
        const b = bufs[j]!;
        const from = j === 0 ? Math.min(skip, b.length) : 0;
        const part = b.subarray(from, from + (length - n));
        out.set(part, n);
        n += part.length;
        if (b.length < pageSize) break; // EOF
      }
      return n === length ? out : out.subarray(0, n);
    },
  };
}
