/**
 * ZarrWorkerPool - Pool of Web Workers for parallel brick loading. Each worker
 * runs fetch + decompress + assemble; main thread only uploads to GPU.
 * Worker selection uses spatial-hash routing (see workerIndexFor) so a
 * brick's chunks land on the same worker's cache, falling back to
 * round-robin when per-LOD params aren't available.
 */

import type { ProviderTimings } from "./data-provider.js";
import { RollingAvg } from "./network-tracker.js";
import { firstChunk, type LodParams } from "./zarr-brick.js";
import type {
  ZarrWorkerRequest,
  ZarrWorkerResponse,
} from "./zarr-chunk-worker.js";
import ZarrChunkWorkerInline from "./zarr-chunk-worker.ts?worker&inline";

/** Dev: URL worker for Vite imports. Prod: pre-bundled inline worker. */
function createWorker(): Worker {
  if (import.meta.env.DEV) {
    // Indirect, so a production build doesn't also emit a URL worker.
    const DevWorker = Worker;
    const devWorkerPath = "./zarr-chunk-worker.ts";
    return new DevWorker(new URL(devWorkerPath, import.meta.url), {
      type: "module",
    });
  }
  return new ZarrChunkWorkerInline();
}

export interface BrickResult {
  data: Uint8Array | Uint16Array;
  min: number;
  max: number;
  avg: number;
  /** Raw-space min (float datasets only) */
  rawMin?: number;
  /** Raw-space max (float datasets only) */
  rawMax?: number;
  /** Real network bytes fetched for this brick's chunks (delta since this worker's previous response). */
  chunkBytesFetched?: number;
  /** Real HTTP requests issued for this brick's chunks (delta since this worker's previous response). */
  chunkRequestsIssued?: number;
}

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

/** A request without its id (assigned per worker). */
type Message = Omit<ZarrWorkerRequest, "id">;

export class ZarrWorkerPool {
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private is16bit = false;
  private queueAvg = new RollingAvg();
  private fetchAvg = new RollingAvg();
  private assemblyAvg = new RollingAvg();
  private chunkHitTotal = 0;
  private chunkReqTotal = 0;

  /** Per-worker last-seen cumulative store bytes/requests, for delta computation. */
  private workerLastBytes: number[] = [];
  private workerLastRequests: number[] = [];

  /** Stored from init() for spatial worker routing (see workerIndexFor). */
  private lodParams: LodParams[] = [];
  private logicalBrickSize = 64;

  /** Abort listeners to clean up on normal completion (prevents stale cancel messages) */
  private abortListeners = new Map<
    number,
    { signal: AbortSignal; listener: () => void }
  >();

  constructor(
    private poolSize: number = navigator.hardwareConcurrency
      ? Math.min(navigator.hardwareConcurrency, 8)
      : 4,
  ) {}

  /**
   * Initialize all workers with the dataset URL, array paths, and brick params.
   * `metadata` holds the metadata documents the main thread already read,
   * so workers open the arrays without fetching them again.
   */
  async init(
    url: string,
    paths: string[],
    lodParams: LodParams[],
    logicalBrickSize: number,
    physicalBrickSize: number,
    is16bit: boolean,
    targetFormat?: "r8unorm" | "r16unorm" | "r16float",
    isFloat32?: boolean,
    floatRange?: [number, number],
    metadata?: Map<string, Uint8Array | null>,
  ): Promise<void> {
    this.is16bit = is16bit;
    this.lodParams = lodParams;
    this.logicalBrickSize = logicalBrickSize;

    for (let i = 0; i < this.poolSize; i++) {
      const worker = createWorker();
      this.workerLastBytes[i] = 0;
      this.workerLastRequests[i] = 0;
      worker.onmessage = (event: MessageEvent<ZarrWorkerResponse>) =>
        this.onMessage(i, event.data);
      worker.onerror = (err) => {
        console.error("ZarrWorkerPool worker error:", err);
      };
      this.workers.push(worker);
    }

    await this.broadcast({
      type: "init",
      url,
      paths,
      metadata,
      lodParams,
      logicalBrickSize,
      physicalBrickSize,
      is16bit,
      targetFormat,
      isFloat32: isFloat32 ?? false,
      floatMin: floatRange?.[0],
      floatMax: floatRange?.[1],
    });
  }

  private onMessage(worker: number, msg: ZarrWorkerResponse): void {
    const { type, id, error, data } = msg;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);

    // Remove abort listener so a later signal.abort() doesn't post a stale cancel
    const entry = this.abortListeners.get(id);
    if (entry) {
      entry.signal.removeEventListener("abort", entry.listener);
      this.abortListeners.delete(id);
    }

    if (error) {
      pending.reject(new Error(error));
    } else if (type !== "loadBrick") {
      pending.resolve(undefined);
    } else if (data) {
      if (msg.queueMs !== undefined) this.queueAvg.add(msg.queueMs);
      if (msg.fetchMs !== undefined) this.fetchAvg.add(msg.fetchMs);
      if (msg.assemblyMs !== undefined) this.assemblyAvg.add(msg.assemblyMs);
      if (msg.chunkHits !== undefined && msg.chunkTotal !== undefined) {
        this.chunkHitTotal += msg.chunkHits;
        this.chunkReqTotal += msg.chunkTotal;
      }
      // Diff against this worker's last-seen cumulative store totals —
      // the store counter is monotonic, so this is exact even if two
      // loadBrick calls overlap on the same worker.
      let chunkBytesFetched: number | undefined;
      let chunkRequestsIssued: number | undefined;
      if (
        msg.chunkStoreBytes !== undefined &&
        msg.chunkStoreRequests !== undefined
      ) {
        chunkBytesFetched = Math.max(
          0,
          msg.chunkStoreBytes - (this.workerLastBytes[worker] ?? 0),
        );
        chunkRequestsIssued = Math.max(
          0,
          msg.chunkStoreRequests - (this.workerLastRequests[worker] ?? 0),
        );
        this.workerLastBytes[worker] = msg.chunkStoreBytes;
        this.workerLastRequests[worker] = msg.chunkStoreRequests;
      }
      pending.resolve({
        data: this.is16bit ? new Uint16Array(data) : new Uint8Array(data),
        min: msg.min ?? 0,
        max: msg.max ?? 0,
        avg: msg.avg ?? 0,
        rawMin: msg.rawMin,
        rawMax: msg.rawMax,
        chunkBytesFetched,
        chunkRequestsIssued,
      } satisfies BrickResult);
    } else {
      pending.reject(new Error("Empty brick response"));
    }
  }

  /** Send `msg` to every worker; resolves once all have acknowledged it. */
  private broadcast(msg: Message): Promise<void> {
    return Promise.all(
      this.workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const id = this.requestId++;
            this.pendingRequests.set(id, { resolve, reject });
            worker.postMessage({ ...msg, id } satisfies ZarrWorkerRequest);
          }),
      ),
    ).then(() => undefined);
  }

  /**
   * Reconfigure target texture format after initialization
   * Format determines output format: r8unorm (8-bit), r16unorm (16-bit uint), r16float (16-bit float)
   */
  setTargetFormat(format: "r8unorm" | "r16unorm" | "r16float"): Promise<void> {
    return this.broadcast({ type: "setTargetFormat", targetFormat: format });
  }

  /**
   * Update the float normalisation range on all workers.
   * Called after base LOD loading derives the actual data range.
   */
  setFloatRange(min: number, max: number): Promise<void> {
    return this.broadcast({
      type: "setFloatRange",
      floatMin: min,
      floatMax: max,
    });
  }

  /**
   * Deterministic worker index for a brick's spatial footprint (independent of
   * channel), so all channels of one brick — and neighboring bricks sharing
   * the same Zarr chunks — land on the same worker's cache. Falls back to -1
   * (round-robin) if lodParams weren't provided at init time.
   */
  private workerIndexFor(
    lod: number,
    bx: number,
    by: number,
    bz: number,
  ): number {
    const params = this.lodParams[lod];
    if (!params || this.workers.length === 0) return -1;
    const L = this.logicalBrickSize;
    const cx = firstChunk(bx, params.scaleX, params.csx, L);
    const cy = firstChunk(by, params.scaleY, params.csy, L);
    const cz = firstChunk(bz, params.scaleZ, params.csz, L);
    let h =
      (cx * 73856093) ^
      (cy * 19349663) ^
      (cz * 83492791) ^
      ((lod + 1) * 2654435761);
    h = ((h ^ (h >>> 13)) * 0x5bd1e995) >>> 0;
    return h % this.workers.length;
  }

  /** Load a 66³ brick, routed to a worker by spatial footprint. Supports AbortSignal cancellation. */
  loadBrick(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    channelIndex = 0,
    signal?: AbortSignal,
  ): Promise<BrickResult> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      let workerIdx = this.workerIndexFor(lod, bx, by, bz);
      if (workerIdx < 0) {
        workerIdx = this.nextWorkerIndex;
        this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
      }
      const worker = this.workers[workerIdx]!;

      this.pendingRequests.set(id, { resolve, reject });

      // Date.now(), not performance.now() — the worker diffs this against its
      // own clock, and only Date.now() shares an epoch across the worker boundary.
      const req: ZarrWorkerRequest = {
        type: "loadBrick",
        id,
        lod,
        bx,
        by,
        bz,
        channelIndex,
        dispatchTime: Date.now(),
      };
      worker.postMessage(req);

      if (signal) {
        const onAbort = () => {
          // Tell the worker, and reject now so the caller doesn't wait.
          worker.postMessage({ type: "cancel", id });
          const pending = this.pendingRequests.get(id);
          if (pending) {
            this.pendingRequests.delete(id);
            pending.reject(new DOMException("Aborted", "AbortError"));
          }
        };

        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          // Store the listener ref so we can remove it on normal completion
          this.abortListeners.set(id, { signal, listener: onAbort });
        }
      }
    });
  }

  getPipelineTimings(): ProviderTimings {
    return {
      avgQueueMs: this.queueAvg.value,
      avgFetchMs: this.fetchAvg.value,
      avgAssemblyMs: this.assemblyAvg.value,
      sampleCount: this.fetchAvg.count,
      chunkCacheHitRatio:
        this.chunkReqTotal > 0 ? this.chunkHitTotal / this.chunkReqTotal : 0,
    };
  }

  terminate(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.pendingRequests.clear();
    this.abortListeners.clear();
  }
}
