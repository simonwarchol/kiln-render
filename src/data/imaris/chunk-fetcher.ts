/**
 * Shared fetcher for compressed HDF5 chunk bytes.
 *
 * One instance per file, on the main thread, in front of every brick worker:
 * - de-duplicates concurrent requests for the same chunk (neighbouring bricks
 *   share chunks through their ghost borders, often across workers);
 * - batches requests issued in the same tick and coalesces nearby byte
 *   ranges into single Range reads;
 * - keeps an LRU of compressed bytes in memory and, for remote files, a
 *   persistent OPFS copy so revisits skip the network;
 * - caps concurrent HTTP requests (browsers allow ~6 per host anyway; more
 *   just queues inside the network stack where we can't prioritise).
 */

import { ByteLru } from "../../utils/byte-lru.js";
import { Limiter } from "../../utils/limiter.js";
import type { RangeSource } from "../hdf5/source.js";
import { coalesceRanges } from "./ims-layout.js";
import { OpfsChunkStore } from "./opfs-chunk-store.js";

export interface ChunkRequest {
  address: number;
  size: number;
}

export interface ChunkFetcherOptions {
  /** In-memory LRU budget for compressed bytes (default 512 MB) */
  budgetBytes?: number;
  /**
   * Persist chunks in the Origin Private File System under this key (the
   * file's URL); omit for local files.
   */
  persistKey?: string;
  /** Max simultaneous Range requests (default 6) */
  maxConcurrent?: number;
  /** Merge ranges separated by up to this many bytes (default 64 KB) */
  maxGap?: number;
  /** Cap on a single coalesced request (default 8 MB) */
  maxRequestBytes?: number;
}

export interface ChunkFetcherStats {
  bytesFetched: number;
  requests: number;
  memoryHits: number;
  persistentHits: number;
  misses: number;
}

export class ChunkFetcher {
  readonly stats: ChunkFetcherStats = {
    bytesFetched: 0,
    requests: 0,
    memoryHits: 0,
    persistentHits: 0,
    misses: 0,
  };
  private readonly lru: ByteLru<number, Uint8Array>;
  private readonly inflight = new Map<number, Promise<Uint8Array>>();
  private queued: Array<{
    req: ChunkRequest;
    resolve: (b: Uint8Array) => void;
    reject: (e: unknown) => void;
  }> = [];
  private flushScheduled = false;
  private readonly net: Limiter;
  private readonly store: OpfsChunkStore | null;
  private readonly maxGap: number;
  private readonly maxRequest: number;

  /** `source` should retry transient failures (the provider's does). */
  constructor(
    private readonly source: RangeSource,
    opts: ChunkFetcherOptions = {},
  ) {
    this.lru = new ByteLru(
      opts.budgetBytes ?? 512 * 1024 * 1024,
      (b) => b.byteLength,
    );
    this.net = new Limiter(opts.maxConcurrent ?? 6);
    this.maxGap = opts.maxGap ?? 64 * 1024;
    this.maxRequest = opts.maxRequestBytes ?? 8 * 1024 * 1024;
    this.store =
      opts.persistKey && OpfsChunkStore.supported()
        ? new OpfsChunkStore(opts.persistKey)
        : null;
  }

  /** Compressed bytes for each chunk, in request order. */
  get(chunks: ChunkRequest[]): Promise<Uint8Array[]> {
    return Promise.all(chunks.map((c) => this.getOne(c)));
  }

  private getOne(c: ChunkRequest): Promise<Uint8Array> {
    const hit = this.lru.get(c.address);
    if (hit) {
      this.stats.memoryHits++;
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(c.address);
    if (pending) return pending;
    const p = new Promise<Uint8Array>((resolve, reject) => {
      this.queued.push({ req: c, resolve, reject });
    });
    this.inflight.set(c.address, p);
    p.then(
      (b) => {
        this.inflight.delete(c.address);
        this.lru.set(c.address, b);
      },
      () => this.inflight.delete(c.address),
    );
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        // Let callers in the same tick add their chunks first.
        setTimeout(() => this.flush(), 0);
      });
    }
    return p;
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const batch = this.queued;
    this.queued = [];
    if (batch.length === 0) return;

    // 1. Persistent store
    const store = this.store;
    let network = batch;
    if (store) {
      const found = await Promise.all(
        batch.map((b) => store.get(b.req.address, b.req.size)),
      );
      network = [];
      batch.forEach((b, i) => {
        const bytes = found[i];
        if (bytes) {
          this.stats.persistentHits++;
          b.resolve(bytes);
        } else {
          network.push(b);
        }
      });
    }
    if (network.length === 0) return;
    this.stats.misses += network.length;

    // 2. Coalesced Range reads
    const groups = coalesceRanges(
      network.map((b) => b.req),
      this.maxGap,
      this.maxRequest,
    );
    await Promise.all(
      groups.map(async (g) => {
        try {
          const bytes = await this.net.run(() =>
            this.source.read(g.start, g.end - g.start),
          );
          this.stats.bytesFetched += g.end - g.start;
          this.stats.requests++;
          for (const i of g.members) {
            const b = network[i]!;
            const off = b.req.address - g.start;
            // A lone chunk is the whole read; coalesced ones are copied out
            // so the cache doesn't pin the gaps between them.
            const chunk =
              g.members.length === 1 && off === 0 && bytes.length === b.req.size
                ? bytes
                : bytes.slice(off, off + b.req.size);
            b.resolve(chunk);
            store?.put(b.req.address, b.req.size, chunk);
          }
        } catch (e) {
          for (const i of g.members) network[i]!.reject(e);
        }
      }),
    );
  }

  clear(): void {
    this.lru.clear();
  }
}
