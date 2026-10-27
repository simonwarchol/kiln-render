/**
 * DecompressionPool - Round-robin Web Worker pool for parallel
 * gzip decompression of brick data off the main thread.
 */

import type {
  DecompressRequest,
  DecompressResponse,
} from "./decompression-worker.js";
import DecompressionWorker from "./decompression-worker.ts?worker&inline";
import type { BrickConversion } from "./sharded-brick.js";

interface PendingRequest {
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
}

export class DecompressionPool {
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();

  constructor(
    poolSize: number = navigator.hardwareConcurrency
      ? Math.min(navigator.hardwareConcurrency, 8)
      : 4,
  ) {
    for (let i = 0; i < poolSize; i++) {
      const worker = new DecompressionWorker();
      worker.onmessage = (event: MessageEvent<DecompressResponse>) => {
        const { id, data, error } = event.data;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        if (error || !data) {
          pending.reject(new Error(error || "Decompression returned null"));
        } else {
          pending.resolve(new Uint8Array(data));
        }
      };
      worker.onerror = (error) => {
        console.error("DecompressionPool worker error:", error);
      };
      this.workers.push(worker);
    }
  }

  /** Gunzip `compressedData` (transferred) and apply `conversion`. */
  decompress(
    compressedData: ArrayBuffer,
    conversion: BrickConversion,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const worker = this.workers[this.nextWorkerIndex]!;
      this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
      this.pendingRequests.set(id, { resolve, reject });
      const request: DecompressRequest = {
        id,
        data: compressedData,
        conversion,
      };
      worker.postMessage(request, [compressedData]);
    });
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    for (const p of this.pendingRequests.values())
      p.reject(new Error("Decompression pool terminated"));
    this.pendingRequests.clear();
  }
}
