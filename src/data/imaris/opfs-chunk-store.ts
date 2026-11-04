/**
 * Persistent store for compressed HDF5 chunks in the Origin Private File
 * System: one directory per source URL, one file per chunk.
 *
 * The directory is listed once on open, so a miss is answered without a
 * file lookup and the network read starts immediately. OPFS reads run at
 * hundreds of MB/s one at a time but slow sharply under concurrency, so reads
 * and writes each go through a small limiter.
 *
 * The cache shares the site's storage quota with Brush's training views, so
 * it keeps the site under half the quota: past that it drops the caches of
 * volumes not open in this page, then the chunks used least recently.
 */

import { Limiter } from "../../utils/limiter.js";

const ROOT = "kiln-ims-chunks";
const READ_CONCURRENCY = 2;
const WRITE_CONCURRENCY = 2;
/** Site storage the cache may grow to, as a share of the quota. */
const QUOTA_SHARE = 0.5;
/** Eviction frees up to this much below the cap, so it runs in batches. */
const EVICT_SLACK = 256 * 2 ** 20;

/** FNV-1a 32-bit — directory name for a URL. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const fileName = (address: number, size: number) => `${address}-${size}`;

export const isQuotaError = (e: unknown): boolean =>
  e instanceof DOMException && e.name === "QuotaExceededError";

/** A volume's chunk directory, shared by every store open on it. */
type ChunkDir = {
  dir: FileSystemDirectoryHandle;
  /** File name → size in bytes, least recently used first. */
  files: Map<string, number>;
};

type Listable = { keys(): AsyncIterable<string> };

let root: Promise<FileSystemDirectoryHandle> | null = null;
const chunkRoot = () => {
  root ??= navigator.storage
    .getDirectory()
    .then((r) => r.getDirectoryHandle(ROOT, { create: true }));
  return root;
};

/** Volume directories open in this page, by name. */
const openDirs = new Map<string, Promise<ChunkDir | null>>();

/** Site usage as of the last estimate, plus chunks written since. */
let used = 0;
/** Site usage the cache may write up to; unlimited until estimated. */
let cap = Number.POSITIVE_INFINITY;
/** Cleared once other site data leaves the cache no room. */
let persisting = true;
let freeing: Promise<unknown> = Promise.resolve();

async function estimate(): Promise<{ usage: number; quota: number }> {
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

/** Where eviction stops: a batch below the cap. */
const belowCap = (quota: number) =>
  quota * QUOTA_SHARE - Math.min(EVICT_SLACK, quota * QUOTA_SHARE * 0.1);

/**
 * Delete cached chunks until the site uses at most `goal(quota)` bytes:
 * volumes not open here first (whole directories), then the open volumes'
 * chunks, least recently used first. Resolves whether the goal was reached.
 */
function shrink(goal: (quota: number) => number): Promise<boolean> {
  const run = freeing.then(async () => {
    let { usage, quota } = await estimate();
    cap = quota * QUOTA_SHARE;
    const target = goal(quota);
    if (usage > target) {
      const base = await chunkRoot();
      const closed: string[] = [];
      for await (const name of (base as unknown as Listable).keys())
        if (!openDirs.has(name)) closed.push(name);
      for (const name of closed) {
        await base.removeEntry(name, { recursive: true }).catch(() => {});
        ({ usage } = await estimate());
        if (usage <= target) break;
      }
    }
    for (const opened of openDirs.values()) {
      const d = await opened;
      if (!d) continue;
      for (const [name, size] of d.files) {
        if (usage <= target) break;
        d.files.delete(name);
        await d.dir.removeEntry(name).catch(() => {});
        usage -= size;
      }
    }
    used = usage;
    return usage <= target;
  });
  freeing = run.catch(() => {});
  return run;
}

/** Read the site's usage and quota; trim the cache if it's over its cap. */
async function checkUsage(): Promise<void> {
  const { usage, quota } = await estimate();
  used = usage;
  cap = quota * QUOTA_SHARE;
  if (used > cap) await shrink(belowCap);
}

/**
 * Drop cached chunks (all of them, if need be) until the site has room for
 * `bytes` more; resolves whether it has.
 */
export async function freeChunkCacheFor(bytes: number): Promise<boolean> {
  if (!OpfsChunkStore.supported()) return false;
  return shrink((quota) => quota - bytes).catch(() => false);
}

async function openDir(name: string): Promise<ChunkDir | null> {
  try {
    const dir = await (await chunkRoot()).getDirectoryHandle(name, {
      create: true,
    });
    const files = new Map<string, number>();
    for await (const f of (dir as unknown as Listable).keys()) {
      const size = Number(f.split("-")[1]);
      if (Number.isFinite(size)) files.set(f, size);
    }
    // Sets the cap, and trims a cache left over it (or from before it).
    void checkUsage().catch(() => {});
    return { dir, files };
  } catch {
    return null;
  }
}

export class OpfsChunkStore {
  /** Directory and the chunk files in it; null when OPFS is unusable. */
  private readonly opened: Promise<ChunkDir | null>;
  /** Resolves once the directory has been listed; `has` is then accurate. */
  readonly ready: Promise<void>;
  private files: Map<string, number> | null = null;
  private readonly reads = new Limiter(READ_CONCURRENCY);
  private readonly writes = new Limiter(WRITE_CONCURRENCY);

  constructor(url: string) {
    const name = hash(url);
    let opened = openDirs.get(name);
    if (!opened) {
      opened = openDir(name);
      openDirs.set(name, opened);
    }
    this.opened = opened;
    this.ready = opened.then((d) => {
      this.files = d?.files ?? null;
    });
  }

  /** Stored (as of the last write), without touching the disk. */
  has(address: number, size: number): boolean {
    return !!this.files?.has(fileName(address, size));
  }

  static supported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.storage?.getDirectory === "function"
    );
  }

  /**
   * Stored bytes, or null if absent. Lower `priority` values are read first;
   * a read whose `cancelled()` is true by its turn rejects with AbortError.
   */
  async get(
    address: number,
    size: number,
    priority = 0,
    cancelled?: () => boolean,
  ): Promise<Uint8Array | null> {
    const d = await this.opened;
    const name = fileName(address, size);
    if (!d?.files.has(name)) return null;
    // Now the most recently used, so evicted last.
    d.files.delete(name);
    d.files.set(name, size);
    return this.reads.run(async () => {
      if (cancelled?.()) {
        throw new DOMException("Chunk read cancelled", "AbortError");
      }
      try {
        const fh = await d.dir.getFileHandle(name);
        const buf = await (await fh.getFile()).arrayBuffer();
        return buf.byteLength === size ? new Uint8Array(buf) : null;
      } catch {
        return null; // removed meanwhile (evicted, or storage cleared)
      }
    }, priority);
  }

  put(address: number, size: number, bytes: Uint8Array): void {
    void this.opened.then((d) => {
      const name = fileName(address, size);
      if (!d || !persisting || d.files.has(name)) return;
      return this.writes.run(async () => {
        if (!persisting) return;
        const write = async () => {
          const fh = await d.dir.getFileHandle(name, { create: true });
          const w = await fh.createWritable();
          await w.write(bytes as Uint8Array<ArrayBuffer>);
          await w.close();
        };
        try {
          if (used + size > cap && !(await shrink(belowCap))) {
            persisting = false; // other site data fills the cache's share
            return;
          }
          try {
            await write();
          } catch (e) {
            if (!isQuotaError(e) || !(await shrink(belowCap))) throw e;
            await write();
          }
          used += size;
          d.files.set(name, size);
        } catch {
          // Out of room even so, or OPFS failing: stop persisting.
          persisting = false;
          await d.dir.removeEntry(name).catch(() => {});
        }
      });
    });
  }
}
