/**
 * ZarrChunkWorker - Web Worker that fetches, decompresses, and assembles
 * 66³ bricks entirely off-thread, transferring results back zero-copy.
 */

import blosc from "numcodecs/blosc";
import lz4 from "numcodecs/lz4";
import zstd from "numcodecs/zstd";
import type { DataType, Readable } from "zarrita";
import { open, registry, root, type Array as ZarrArray } from "zarrita";
import { SharedFetchRegistry } from "./shared-fetch.js";
import { TolerantFetchStore } from "./tolerant-fetch-store.js";
import {
  assembleBrick,
  chunkCoords,
  type DecodedChunk,
  type LodParams,
  planBrick,
} from "./zarr-brick.js";

// Static codec imports — zarrita's dynamic imports fail in Vite dev workers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set("blosc", async () => blosc as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set("lz4", async () => lz4 as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set("zstd", async () => zstd as any);

/** Messages from main thread to worker */
export interface ZarrWorkerRequest {
  type: "init" | "loadBrick" | "setTargetFormat" | "setFloatRange" | "cancel";
  id: number;
  /** For 'init': dataset URL and array paths */
  url?: string;
  paths?: string[];
  /** For 'init': metadata documents the main thread already fetched (key → bytes, null = absent) */
  metadata?: Map<string, Uint8Array | null>;
  /** For 'loadBrick': brick parameters */
  lod?: number;
  bx?: number;
  by?: number;
  bz?: number;
  /** Brick assembly parameters (sent with init, cached in worker) */
  logicalBrickSize?: number;
  physicalBrickSize?: number;
  /** Per-LOD scale factors and chunk info (sent with init) */
  lodParams?: LodParams[];
  /** Channel index to load (for datasets with a channel axis) */
  channelIndex?: number;
  /**
   * Main-thread timestamp (Date.now — NOT performance.now, which has a
   * per-context time origin and can't be diffed across the worker boundary)
   * when request was dispatched, for queue wait measurement.
   */
  dispatchTime?: number;
  is16bit?: boolean;
  /** Target texture format: r8unorm (8-bit), r16unorm (16-bit uint), r16float (16-bit float) */
  targetFormat?: "r8unorm" | "r16unorm" | "r16float";
  /** Whether source data is float32/float64 */
  isFloat32?: boolean;
  /** Float normalisation range — voxel values are mapped from [floatMin, floatMax] → [0, 65535] */
  floatMin?: number;
  floatMax?: number;
}

/** Messages from worker to main thread */
export interface ZarrWorkerResponse {
  type: "init" | "loadBrick" | "setTargetFormat" | "setFloatRange";
  id: number;
  error?: string;
  /** For 'loadBrick': assembled brick data (transferable) */
  data?: ArrayBuffer;
  /** Brick stats */
  min?: number;
  max?: number;
  avg?: number;
  /** Raw-space min/max for float data (before normalisation) — used for range derivation */
  rawMin?: number;
  rawMax?: number;
  /** Per-stage timing (ms) — for pipeline telemetry */
  fetchMs?: number;
  assemblyMs?: number;
  /** Worker queue wait: dispatchTime → worker starts processing (ms) */
  queueMs?: number;
  /** Chunk-cache hit ratio for this brick (hits / total chunks needed) */
  chunkHits?: number;
  chunkTotal?: number;
  /**
   * Cumulative real network bytes/requests fetched by this worker's store so
   * far (never reset) — the pool diffs consecutive values per worker to get
   * an exact delta without needing a shared/reset-able counter.
   */
  chunkStoreBytes?: number;
  chunkStoreRequests?: number;
}

// Worker state
let arrays: ZarrArray<DataType, Readable>[] = [];
let LOGICAL_SIZE = 64;
let PHYSICAL_SIZE = 66;
let lodParams: LodParams[] = [];
let is16bit = false;
let targetFormat: "r8unorm" | "r16unorm" | "r16float" = "r16unorm";
let isFloat32 = false;
let floatMin = 0;
let floatMax = 1;

// Per-worker decoded-chunk cache (LRU by Map order, bounded by bytes). The
// budget holds ~8 of the largest chunks seen, within [32 MB, 256 MB]: big
// chunks would otherwise evict each other within a single brick.
const chunkCache = new Map<string, DecodedChunk & { bytes: number }>();
let cacheBytes = 0;
let largestChunkBytes = 0;
const MIN_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

function cacheBudgetBytes(): number {
  return Math.min(
    MAX_CACHE_BYTES,
    Math.max(MIN_CACHE_BYTES, 8 * largestChunkBytes),
  );
}

// In-flight chunk fetches, shared by every brick that needs the chunk. The
// shared fetch has its own AbortController and is only aborted once every
// caller has given up (see SharedFetchRegistry).
const sharedFetches = new SharedFetchRegistry<DecodedChunk>();

function fetchChunkShared(
  arr: ZarrArray<DataType, Readable>,
  coords: number[],
  key: string,
  signal?: AbortSignal,
): Promise<DecodedChunk> {
  return sharedFetches.run(
    key,
    (fetchSignal) =>
      arr
        .getChunk(coords, { signal: fetchSignal } as RequestInit)
        .then((chunk) => {
          const result = {
            data: chunk.data as unknown as ArrayLike<number>,
            shape: chunk.shape,
          };
          cacheSet(key, result);
          return result;
        }),
    signal,
  );
}

// Store reference
let workerStore: TolerantFetchStore | null = null;

// Cancellation state
const cancelledRequests = new Set<number>();
const activeControllers = new Map<number, AbortController>();

function byteLength(data: ArrayLike<number>): number {
  return ArrayBuffer.isView(data)
    ? data.byteLength
    : data.length * (is16bit ? 2 : 1);
}

function cacheSet(key: string, chunk: DecodedChunk): void {
  const bytes = byteLength(chunk.data);
  if (bytes > largestChunkBytes) largestChunkBytes = bytes;
  const old = chunkCache.get(key);
  if (old) {
    cacheBytes -= old.bytes;
    chunkCache.delete(key);
  }
  const budget = cacheBudgetBytes();
  while (cacheBytes + bytes > budget && chunkCache.size > 0) {
    const oldest = chunkCache.keys().next().value!;
    cacheBytes -= chunkCache.get(oldest)!.bytes;
    chunkCache.delete(oldest);
  }
  chunkCache.set(key, { ...chunk, bytes });
  cacheBytes += bytes;
}

const post = (msg: ZarrWorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (event: MessageEvent<ZarrWorkerRequest>) => {
  const { type, id } = event.data;

  // Cancel messages are handled immediately — not queued.
  // They must arrive and take effect even while a loadBrick is in progress.
  if (type === "cancel") {
    cancelledRequests.add(id);
    activeControllers.get(id)?.abort();
    return;
  }

  if (type === "setTargetFormat") {
    targetFormat = event.data.targetFormat ?? "r16unorm";
    post({ type: "setTargetFormat", id });
    return;
  }

  if (type === "setFloatRange") {
    floatMin = event.data.floatMin ?? 0;
    floatMax = event.data.floatMax ?? 1;
    post({ type: "setFloatRange", id });
    return;
  }

  if (type === "init") {
    // Init is called once at startup before any loadBrick — safe to handle directly
    (async () => {
      try {
        const { url, paths } = event.data;
        LOGICAL_SIZE = event.data.logicalBrickSize ?? 64;
        PHYSICAL_SIZE = event.data.physicalBrickSize ?? 66;
        lodParams = event.data.lodParams ?? [];
        is16bit = event.data.is16bit ?? false;
        targetFormat = event.data.targetFormat ?? "r16unorm";
        isFloat32 = event.data.isFloat32 ?? false;
        floatMin = event.data.floatMin ?? 0;
        floatMax = event.data.floatMax ?? 1;

        workerStore = new TolerantFetchStore(url!, {
          metadata: event.data.metadata,
        });
        const rootGroup = await open(root(workerStore), { kind: "group" });

        arrays = [];
        for (const path of paths!) {
          const arr = await open(rootGroup.resolve(path), { kind: "array" });
          arrays.push(arr);
        }

        post({ type: "init", id });
      } catch (e) {
        post({
          type: "init",
          id,
          error: e instanceof Error ? e.message : "Init failed",
        });
      }
    })();
    return;
  }

  if (type === "loadBrick") {
    const { lod, bx, by, bz, dispatchTime } = event.data;
    const channelIndex = event.data.channelIndex ?? 0;
    // dispatchTime is Date.now() from the main thread — Date.now() shares the
    // same epoch across contexts, unlike performance.now() (per-context origin).
    const queueMs =
      dispatchTime !== undefined ? Date.now() - dispatchTime : undefined;

    // Already cancelled before we started? Skip entirely.
    if (cancelledRequests.has(id)) {
      cancelledRequests.delete(id);
      return;
    }

    const controller = new AbortController();
    activeControllers.set(id, controller);

    (async () => {
      try {
        const result = await loadBrick(
          lod!,
          bx!,
          by!,
          bz!,
          channelIndex,
          controller.signal,
        );

        activeControllers.delete(id);
        cancelledRequests.delete(id);

        if (controller.signal.aborted) return;

        const buffer = result.data.buffer as ArrayBuffer;
        post(
          {
            type: "loadBrick",
            id,
            data: buffer,
            min: result.min,
            max: result.max,
            avg: result.avg,
            rawMin: result.rawMin,
            rawMax: result.rawMax,
            fetchMs: result.fetchMs,
            assemblyMs: result.assemblyMs,
            queueMs,
            chunkHits: result.chunkHits,
            chunkTotal: result.chunkTotal,
            chunkStoreBytes: workerStore?.bytesFetched,
            chunkStoreRequests: workerStore?.requestCount,
          },
          [buffer],
        );
      } catch (e) {
        activeControllers.delete(id);
        cancelledRequests.delete(id);

        if (e instanceof DOMException && e.name === "AbortError") return;

        post({
          type: "loadBrick",
          id,
          error: e instanceof Error ? e.message : "loadBrick failed",
        });
      }
    })();
  }
};

/** 16-bit brick → its high bytes, with stats over the 8-bit output. */
function toHighBytes(brick: Uint16Array) {
  const out = new Uint8Array(brick.length);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < brick.length; i++) {
    const v = brick[i]! >> 8;
    out[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { data: out, min, max, avg: sum / brick.length };
}

/** Fetch the chunks a brick overlaps (cached, shared in flight) and assemble it. */
async function loadBrick(
  lod: number,
  bx: number,
  by: number,
  bz: number,
  channelIndex: number,
  signal: AbortSignal,
) {
  const arr = arrays[lod]!;
  const params = lodParams[lod]!;
  const plan = planBrick(params, bx, by, bz, LOGICAL_SIZE, PHYSICAL_SIZE);

  // --- Stage 1: chunk fetch (HTTP + zarr decompression, parallel, with cache + dedup) ---
  const t0 = performance.now();
  const chunks = new Array<DecodedChunk | null>(plan.count).fill(null);
  let chunkHits = 0;
  const fetches: Promise<void>[] = [];
  let fi = 0;
  for (let cz = plan.minCz; cz <= plan.maxCz; cz++) {
    for (let cy = plan.minCy; cy <= plan.maxCy; cy++) {
      for (let cx = plan.minCx; cx <= plan.maxCx; cx++, fi++) {
        const key = `${lod}:ch${channelIndex}:${cz}/${cy}/${cx}`;
        const cached = chunkCache.get(key);
        if (cached) {
          // refresh recency: delete+re-set moves to end of map iteration order (LRU)
          chunkCache.delete(key);
          chunkCache.set(key, cached);
          chunks[fi] = cached;
          chunkHits++;
          continue;
        }
        const i = fi;
        const coords = chunkCoords(params, channelIndex, cz, cy, cx);
        fetches.push(
          fetchChunkShared(arr, coords, key, signal).then((c) => {
            chunks[i] = c;
          }),
        );
      }
    }
  }
  if (fetches.length > 0) await Promise.all(fetches);
  const fetchMs = performance.now() - t0;

  // Abort check between fetch and assembly — the CPU-bound assembly loop
  // can't yield, so this is the last interruptible point.
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  // --- Stage 2: brick assembly (LUT-based voxel scatter + format conversion) ---
  const t1 = performance.now();
  let brick = assembleBrick(plan, chunks, {
    isFloat: isFloat32,
    floatMin,
    floatMax,
    out: is16bit ? "u16" : "u8",
    encode: is16bit && targetFormat === "r16float" ? "f16" : "raw",
  });
  if (is16bit && targetFormat === "r8unorm") {
    // No 16-bit atlas: 8-bit output (and stats).
    brick = { ...brick, ...toHighBytes(brick.data as Uint16Array) };
  }
  return {
    ...brick,
    fetchMs,
    assemblyMs: performance.now() - t1,
    chunkHits,
    chunkTotal: plan.count,
  };
}
