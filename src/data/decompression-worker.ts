/** DecompressionWorker - Off-main-thread gzip decompression via fflate. */

import { gunzipSync } from "fflate";
import { type BrickConversion, convertBrick } from "./sharded-brick.js";

export interface DecompressRequest {
  id: number;
  data: ArrayBuffer;
  /** Conversion to the atlas format, applied after decompression */
  conversion: BrickConversion;
}

export interface DecompressResponse {
  id: number;
  data: ArrayBuffer | null;
  error?: string;
}

self.onmessage = (event: MessageEvent<DecompressRequest>) => {
  const { id, data, conversion } = event.data;
  const post = (r: DecompressResponse, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage(r, transfer);
  try {
    const out = convertBrick(gunzipSync(new Uint8Array(data)), conversion);
    // Transfer back zero-copy (a view that doesn't span its buffer is copied).
    const buffer =
      out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
        ? (out.buffer as ArrayBuffer)
        : (out.slice().buffer as ArrayBuffer);
    post({ id, data: buffer }, [buffer]);
  } catch (error) {
    post({
      id,
      data: null,
      error: error instanceof Error ? error.message : "Decompression failed",
    });
  }
};
