/**
 * Emscripten lazy file backed by synchronous HTTP Range requests.
 * Worker-only — browsers forbid sync XHR on the main thread.
 */

const CHUNK_SIZE = 256 * 1024;
const LRU_CHUNKS = 256;

class ChunkLru {
  private readonly map = new Map<number, Uint8Array>();

  constructor(private readonly max: number) {}

  get(key: number): Uint8Array | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: number, value: Uint8Array): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

export type LazyHdf5Source = { url: string } | { file: File };

export class RangeLazyArray {
  totalFetchedBytes = 0;
  totalRequests = 0;
  private length_: number | null = null;
  private readonly cache = new ChunkLru(LRU_CHUNKS);

  constructor(private readonly source: LazyHdf5Source) {}

  get length(): number {
    if (this.length_ === null) this.probeLength();
    return this.length_ ?? 0;
  }

  copyInto(
    buffer: Uint8Array,
    outOffset: number,
    length: number,
    start: number,
  ): number {
    const size = this.length;
    if (start >= size) return 0;
    length = Math.min(size - start, length);
    let i = 0;
    while (i < length) {
      const idx = start + i;
      const chunkNum = (idx / CHUNK_SIZE) | 0;
      const chunkOff = idx % CHUNK_SIZE;
      const want = Math.min(CHUNK_SIZE - chunkOff, length - i);
      const chunk = this.getChunk(chunkNum);
      buffer.set(chunk.subarray(chunkOff, chunkOff + want), outOffset + i);
      i += want;
    }
    return length;
  }

  private probeLength(): void {
    if ("file" in this.source) {
      this.length_ = this.source.file.size;
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("HEAD", this.source.url, false);
    xhr.send(null);
    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error(`HEAD ${this.source.url} failed: ${xhr.status}`);
    }
    const len = Number(xhr.getResponseHeader("Content-Length"));
    if (!Number.isFinite(len) || len <= 0) {
      throw new Error("IMS host did not report Content-Length");
    }
    this.length_ = len;
  }

  private getChunk(chunkNum: number): Uint8Array {
    const cached = this.cache.get(chunkNum);
    if (cached) return cached;
    const from = chunkNum * CHUNK_SIZE;
    const to = Math.min(from + CHUNK_SIZE, this.length) - 1;
    const buf = this.rangeGet(from, to);
    const chunk = new Uint8Array(buf);
    this.cache.set(chunkNum, chunk);
    return chunk;
  }

  private rangeGet(from: number, to: number): ArrayBuffer {
    this.totalFetchedBytes += to - from + 1;
    this.totalRequests++;
    if ("file" in this.source) {
      return readBlobSync(this.source.file.slice(from, to + 1));
    }
    const xhr = new XMLHttpRequest();
    xhr.open("GET", this.source.url, false);
    xhr.setRequestHeader("Range", `bytes=${from}-${to}`);
    xhr.responseType = "arraybuffer";
    xhr.send(null);
    if (xhr.status !== 206 && xhr.status !== 200) {
      throw new Error(`Range ${from}-${to} failed: ${xhr.status}`);
    }
    if (xhr.status === 200 && !xhr.getResponseHeader("Content-Range")) {
      throw new Error("IMS host ignored HTTP Range and returned the full file");
    }
    return xhr.response as ArrayBuffer;
  }
}

function readBlobSync(blob: Blob): ArrayBuffer {
  const SyncReader = (
    globalThis as unknown as {
      FileReaderSync?: new () => {
        readAsArrayBuffer: (b: Blob) => ArrayBuffer;
      };
    }
  ).FileReaderSync;
  if (!SyncReader) {
    throw new Error("Local IMS reads require a Worker (FileReaderSync)");
  }
  return new SyncReader().readAsArrayBuffer(blob);
}

interface EmscriptenFS {
  createFile: (
    parent: string,
    name: string,
    props: object,
    canRead: boolean,
    canWrite: boolean,
  ) => {
    contents: unknown;
    stream_ops: Record<string, (...args: never[]) => unknown>;
  };
  forceLoadFile: (node: unknown) => void;
}

/** Mount a remote URL or local File as `/name` on an Emscripten FS (h5wasm). */
export function createRangeLazyFile(
  FS: EmscriptenFS,
  name: string,
  source: LazyHdf5Source,
): RangeLazyArray {
  const lazy = new RangeLazyArray(source);
  const node = FS.createFile("/", name, { contents: lazy }, true, false);
  node.contents = lazy;
  Object.defineProperty(node, "usedBytes", {
    get() {
      return lazy.length;
    },
  });
  const streamOps = { ...node.stream_ops };
  streamOps.read = (
    stream: { node: { contents: RangeLazyArray } },
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => {
    FS.forceLoadFile(node);
    return stream.node.contents.copyInto(buffer, offset, length, position);
  };
  node.stream_ops = streamOps;
  return lazy;
}
