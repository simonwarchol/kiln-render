/**
 * Pool of IMS workers (h5wasm + Range). Each worker holds its own HDF5 handle.
 */

import type { PipelineTimings } from "./data-provider.js";
import type {
  ImsWorkerMetadata,
  ImsWorkerRequest,
  ImsWorkerResponse,
} from "./imaris-chunk-worker.js";
import ImarisChunkWorkerInline from "./imaris-chunk-worker.ts?worker&inline";
import { RollingAvg } from "./network-tracker.js";

function createWorker(): Worker {
  if (import.meta.env.DEV) {
    return new Worker(new URL("./imaris-chunk-worker.ts", import.meta.url), {
      type: "module",
    });
  }
  return new ImarisChunkWorkerInline();
}

export interface ImsBrickResult {
  data: Uint8Array | Uint16Array;
  min: number;
  max: number;
  avg: number;
  rawMin?: number;
  rawMax?: number;
  chunkBytesFetched?: number;
  chunkRequestsIssued?: number;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/** Spatial hash → worker index; channel offset fans out multi-channel loads. */
export function imarisWorkerIndex(
  lod: number,
  bx: number,
  by: number,
  bz: number,
  channelIndex: number,
  poolSize: number,
): number {
  if (poolSize <= 0) return 0;
  let h =
    (bx * 73856093) ^
    (by * 19349663) ^
    (bz * 83492791) ^
    ((lod + 1) * 2654435761);
  h = ((h ^ (h >>> 13)) * 0x5bd1e995) >>> 0;
  return (h + channelIndex) % poolSize;
}

export class ImarisWorkerPool {
  private workers: Worker[] = [];
  private requestId = 0;
  private pending = new Map<number, Pending>();
  private requestToWorker = new Map<number, number>();
  private abortListeners = new Map<
    number,
    { signal: AbortSignal; listener: () => void }
  >();
  private workerLastBytes: number[] = [];
  private workerLastRequests: number[] = [];
  private fetchAvg = new RollingAvg();
  private assemblyAvg = new RollingAvg();
  private queueAvg = new RollingAvg();
  private is16bit = false;
  private targetFormat: "r8unorm" | "r16unorm" | "r16float" = "r16float";

  constructor(
    private readonly poolSize = Math.min(navigator.hardwareConcurrency || 4, 4),
  ) {}

  async init(source: string | File): Promise<ImsWorkerMetadata> {
    const inits: Promise<ImsWorkerMetadata>[] = [];
    for (let i = 0; i < this.poolSize; i++) {
      const worker = createWorker();
      this.workerLastBytes[i] = 0;
      this.workerLastRequests[i] = 0;
      worker.onmessage = (event: MessageEvent<ImsWorkerResponse>) => {
        this.onMessage(i, event.data);
      };
      this.workers.push(worker);
      inits.push(
        new Promise((resolve, reject) => {
          const id = this.requestId++;
          this.pending.set(id, {
            resolve: (meta) => resolve(meta as ImsWorkerMetadata),
            reject,
          });
          const req: ImsWorkerRequest =
            typeof source === "string"
              ? { type: "init", id, url: source }
              : { type: "init", id, file: source };
          worker.postMessage(req);
        }),
      );
    }
    const metas = await Promise.all(inits);
    const meta = metas[0];
    if (!meta) throw new Error("IMS worker init returned no metadata");
    this.is16bit = meta.bitDepth === 16;
    return meta;
  }

  async setTargetFormat(
    format: "r8unorm" | "r16unorm" | "r16float",
  ): Promise<void> {
    this.targetFormat = format;
    await Promise.all(
      this.workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const id = this.requestId++;
            this.pending.set(id, {
              resolve: () => resolve(),
              reject,
            });
            worker.postMessage({
              type: "setTargetFormat",
              id,
              targetFormat: format,
            } satisfies ImsWorkerRequest);
          }),
      ),
    );
  }

  async setFloatRange(min: number, max: number): Promise<void> {
    await Promise.all(
      this.workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const id = this.requestId++;
            this.pending.set(id, {
              resolve: () => resolve(),
              reject,
            });
            worker.postMessage({
              type: "setFloatRange",
              id,
              floatMin: min,
              floatMax: max,
            } satisfies ImsWorkerRequest);
          }),
      ),
    );
  }

  loadBrick(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    channelIndex = 0,
    signal?: AbortSignal,
  ): Promise<ImsBrickResult> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const workerIdx = imarisWorkerIndex(
        lod,
        bx,
        by,
        bz,
        channelIndex,
        this.workers.length,
      );
      const worker = this.workers[workerIdx];
      if (!worker) {
        reject(new Error("IMS worker pool is empty"));
        return;
      }
      this.pending.set(id, {
        resolve: (r) => resolve(r as ImsBrickResult),
        reject,
      });
      this.requestToWorker.set(id, workerIdx);
      worker.postMessage({
        type: "loadBrick",
        id,
        lod,
        bx,
        by,
        bz,
        channelIndex,
        dispatchTime: Date.now(),
      } satisfies ImsWorkerRequest);

      if (signal) {
        const onAbort = () => {
          worker.postMessage({ type: "cancel", id } satisfies ImsWorkerRequest);
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            this.requestToWorker.delete(id);
            pending.reject(new DOMException("Aborted", "AbortError"));
          }
        };
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          this.abortListeners.set(id, { signal, listener: onAbort });
        }
      }
    });
  }

  getPipelineTimings(): PipelineTimings {
    return {
      avgQueueMs: this.queueAvg.value,
      avgFetchMs: this.fetchAvg.value,
      avgAssemblyMs: this.assemblyAvg.value,
      avgUploadMs: 0,
      sampleCount: this.fetchAvg.count,
    };
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.pending.clear();
    this.requestToWorker.clear();
    this.abortListeners.clear();
  }

  private onMessage(workerIdx: number, msg: ImsWorkerResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    this.requestToWorker.delete(msg.id);
    const abort = this.abortListeners.get(msg.id);
    if (abort) {
      abort.signal.removeEventListener("abort", abort.listener);
      this.abortListeners.delete(msg.id);
    }

    if (msg.error) {
      pending.reject(new Error(msg.error));
      return;
    }

    if (msg.fetchMs !== undefined) this.fetchAvg.add(msg.fetchMs);
    if (msg.assemblyMs !== undefined) this.assemblyAvg.add(msg.assemblyMs);
    if (msg.queueMs !== undefined) this.queueAvg.add(msg.queueMs);

    if (msg.type === "loadBrick") {
      const bytes = msg.chunkStoreBytes ?? 0;
      const reqs = msg.chunkStoreRequests ?? 0;
      const deltaBytes = Math.max(
        0,
        bytes - (this.workerLastBytes[workerIdx] ?? 0),
      );
      const deltaReqs = Math.max(
        0,
        reqs - (this.workerLastRequests[workerIdx] ?? 0),
      );
      this.workerLastBytes[workerIdx] = bytes;
      this.workerLastRequests[workerIdx] = reqs;
      const source =
        this.is16bit && this.targetFormat !== "r8unorm"
          ? new Uint16Array(msg.data ?? new ArrayBuffer(0))
          : new Uint8Array(msg.data ?? new ArrayBuffer(0));
      pending.resolve({
        data: source,
        min: msg.min ?? 0,
        max: msg.max ?? 0,
        avg: msg.avg ?? 0,
        rawMin: msg.rawMin,
        rawMax: msg.rawMax,
        chunkBytesFetched: deltaBytes,
        chunkRequestsIssued: deltaReqs,
      } satisfies ImsBrickResult);
      return;
    }

    pending.resolve(msg.metadata);
  }
}
