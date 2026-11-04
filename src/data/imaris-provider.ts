/**
 * ImarisDataProvider — streams Imaris 5.5 (.ims) files over async HTTP Range
 * requests (or a local File) with a pure-TS HDF5 reader.
 *
 * - Metadata and chunk indexes are read on the main thread (small, cached
 *   page reads); bulk chunk bytes are fetched, decoded and assembled into
 *   bricks by a worker pool.
 * - Exposes a virtual isotropic pyramid over Imaris' anisotropic levels
 *   (see imaris/ims-layout.ts).
 * - Values are normalised per channel to [0, 1] using the file's histogram
 *   range, so all dtypes land in the same r16float space and the default
 *   display windows come straight from the Imaris ColorRange.
 * - Up to MAX_CHANNELS of the file's channels are active at once; choose
 *   them with `channels`.
 */

import {
  LOGICAL_BRICK_SIZE,
  MAX_CHANNELS,
  PHYSICAL_BRICK_SIZE,
} from "../core/config.js";
import { ByteLru } from "../utils/byte-lru.js";
import type {
  BrickLoadResult,
  BrickStaleListener,
  BrickStats,
  DataProvider,
  NetworkStats,
  ProviderTimings,
  VolumeMetadata,
} from "./data-provider.js";
import { UnsupportedDatasetError } from "./data-provider.js";
import {
  blobRangeSource,
  type CachedRangeSource,
  cachedRangeSource,
  Hdf5Dataset,
  Hdf5File,
  Hdf5Group,
  httpRangeSource,
  type RangeSource,
} from "./hdf5/index.js";
import { ChunkFetcher } from "./imaris/chunk-fetcher.js";
import {
  buildImsChunkIndex,
  ChunkIndexFile,
  type ChunkTable,
  readChunkTable,
} from "./imaris/chunk-index-file.js";
import { imsBrickIsEmpty } from "./imaris/empty-bricks.js";
import type {
  ImsAssembleRequest,
  ImsBrickResponse,
  ImsExtractRequest,
  ImsExtractResponse,
  ImsInitRequest,
  ImsPiece,
} from "./imaris/ims-brick-worker.js";
import ImsBrickWorkerInline from "./imaris/ims-brick-worker.ts?worker&inline";
import {
  axisSampling,
  type BorderPlan,
  clampGhost,
  DECODED_CHUNK_BUDGET,
  faceBit,
  overlappingChunks,
  planBorders,
  planVirtualPyramid,
  type SourceLevel,
  type Vec3,
  type VirtualLevel,
  WORKER_CHUNK_BUDGET,
} from "./imaris/ims-layout.js";
import {
  attrNumber,
  type ImsChannelInfo,
  type ImsVolumeInfo,
  imsVolumeProblems,
  readImsVolumeInfo,
} from "./imaris/volume-info.js";
import { NetworkTracker, RollingAvg } from "./network-tracker.js";

export type { ImsChannelInfo } from "./imaris/volume-info.js";

const MAX_STATS_ENTRIES = 200_000;
/**
 * Compressed chunk bytes kept in memory. Remote files also persist chunks in
 * OPFS, so revisits are cheap either way; local files re-read from disk.
 */
const REMOTE_CHUNK_BUDGET = 192 * 1024 * 1024;
const LOCAL_CHUNK_BUDGET = 64 * 1024 * 1024;
/** Metadata page cache: generous while chunk indexes load, small after. */
const META_PAGES = 8192; // × 16 KB
const META_PAGES_AFTER_INDEX = 256;
/**
 * Metadata reads (mostly chunk-index nodes, scattered 16 KB pages) running
 * at once while chunks are being fetched: browsers allow ~6 connections per
 * host, and a level's index can be hundreds of reads per channel.
 */
const META_READS_WHILE_FETCHING = 2;
/**
 * …and while only background index reads run, with chunk reads idle (they
 * pause while chunks are fetched): at most the connections a browser opens
 * per host, so none queue behind them and chunk reads that start meanwhile
 * wait one round trip at most.
 */
const META_READS_IN_BACKGROUND = 6;
/** Clamped brick channels watched for their missing chunks (oldest dropped). */
const MAX_CLAMPED = 65_536;
/** Stale-brick reports are batched over this long. */
const STALE_NOTIFY_MS = 100;

/** A channel's histogram as the file stores it (full resolution). */
export interface ImsChannelHistogram {
  /** Voxel counts per bin, bins evenly spaced over [min, max] */
  counts: number[];
  /** HistogramMin (raw units) */
  min: number;
  /** HistogramMax (raw units) */
  max: number;
}

export interface ImarisProviderOptions {
  /** Source channel indices to load (≤ MAX_CHANNELS). Default: the first ones. */
  channels?: number[];
  /** Time point to load (default 0). */
  timepoint?: number;
  /**
   * Worker count (default: half the cores, up to 4, for URLs; cores − 1, up
   * to 8, for local files). Workers start with the first brick load.
   */
  workers?: number;
  /** Keep fetched chunks in the Origin Private File System across sessions (default true). */
  persistentCache?: boolean;
  /**
   * URL of a saved chunk index (see `buildChunkIndex`); its tables replace
   * reading the file's chunk B-trees. Default: "<url>.index" next to the
   * file. `false`: none.
   */
  chunkIndex?: string | false;
}

function createWorker(): Worker {
  if (import.meta.env.DEV) {
    return new Worker(
      new URL("./imaris/ims-brick-worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
  }
  return new ImsBrickWorkerInline();
}

/**
 * A channel's display window in raw data units over its normalisation range;
 * the viewer maps it to the normalised [0, 1] atlas values.
 */
function channelWindow(ch: ImsChannelInfo) {
  const [lo, hi] = ch.range;
  const [a, b] = ch.displayRange ?? ch.range;
  const start = Math.min(hi, Math.max(lo, a));
  const end = Math.min(hi, Math.max(start + (hi - lo) * 1e-3, b));
  return { start, end, min: lo, max: hi };
}

/** Chunk → owning worker (each chunk is decoded and cached by one worker). */
function ownerOf(address: number, n: number): number {
  let h = Math.floor(address / 4096) ^ (address % 4096);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) % n;
}

/**
 * One dataset's chunk index as flat arrays over the chunk grid (linear index
 * (cz * grid[1] + cy) * grid[0] + cx): ~12 bytes per chunk instead of a ref
 * object per chunk.
 */
interface DatasetIndex extends ChunkTable {
  dataset: Hdf5Dataset;
}

const chunkIndex = (idx: DatasetIndex, cx: number, cy: number, cz: number) =>
  (cz * idx.grid[1] + cy) * idx.grid[0] + cx;

/** A brick channel returned with edge-clamped parts of its ghost border. */
interface ClampedBrick {
  key: string;
  lod: number;
  bx: number;
  by: number;
  bz: number;
  channelIndex: number;
  /** Per BorderPlan.waiting group: chunk addresses it still waits for. */
  waiting: Array<Set<number>>;
}

export class ImarisDataProvider implements DataProvider {
  private readonly tracker = new NetworkTracker();
  private file: Hdf5File | null = null;
  private raw: RangeSource | null = null;
  private meta: CachedRangeSource | null = null;
  private metadata: VolumeMetadata | null = null;
  private pyramid: VirtualLevel[] = [];
  private sourceLevels: SourceLevel[] = [];
  /** Per brick, the stats of each channel slot loaded for it. */
  private readonly brickStatsCache = new Map<
    string,
    Array<BrickStats | undefined>
  >();
  private readonly datasetIndex = new Map<string, Promise<DatasetIndex>>();
  /** Chunk indexes being read (the metadata page cache is large meanwhile). */
  private indexReads = 0;
  /** Indexes read in full, by `level:channel`. */
  private readonly indexReady = new Set<string>();
  /** Waits on an index by a brick load (the rest are background reads). */
  private urgentIndexWaits = 0;
  /** Background index reads are under way (one index at a time). */
  private prefetching = false;
  /** Metadata reads in flight, and those waiting for a slot. */
  private metaReads = 0;
  private readonly metaWaiting: Array<() => void> = [];
  private format: "f16" | "u8" = "f16";
  private workers: Worker[] = [];
  private fetcher: ChunkFetcher | null = null;
  private requestId = 0;
  private readonly pending = new Map<
    number,
    {
      worker: number;
      resolve: (r: ImsBrickResponse | ImsExtractResponse) => void;
      reject: (e: Error) => void;
    }
  >();
  /** Per worker: chunks it holds decoded (address → bytes), as an LRU like its own. */
  private ownerMirror: Array<ByteLru<number, number>> = [];
  /** Per worker: requests posted and not answered yet. */
  private load: number[] = [];
  private readonly fetchAvg = new RollingAvg();
  private readonly assemblyAvg = new RollingAvg();
  private readonly queueAvg = new RollingAvg();
  private readonly timepoint: number;
  /** Clamped brick channels by `lod:bx/by/bz:channel`, oldest first. */
  private readonly clamped = new Map<string, ClampedBrick>();
  /** Chunk address → clamped bricks waiting for it. */
  private readonly waitingOn = new Map<number, Set<ClampedBrick>>();
  private stale: ClampedBrick[] = [];
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private staleListener: BrickStaleListener | null = null;
  /** The saved chunk index, once looked for (null: none). */
  private savedIndex: Promise<ChunkIndexFile | null> = Promise.resolve(null);
  /** The file, once opened: on first use when the saved index describes it. */
  private opening: Promise<Hdf5File> | null = null;
  /** What `initialize` knew of the volume. */
  private info: ImsVolumeInfo | null = null;
  /** `info` came from the saved index rather than the file. */
  private describedByIndex = false;

  /** Every channel in the file (names, colours, ranges). */
  allChannels: ImsChannelInfo[] = [];
  /** Source channel index for each active slot. */
  activeChannels: number[] = [];
  /** URL of the saved chunk index in use (null: none found). */
  private chunkIndexUrl: string | null = null;

  constructor(
    private readonly source: string | File,
    private readonly options: ImarisProviderOptions = {},
  ) {
    this.timepoint = options.timepoint ?? 0;
  }

  async setTargetFormat(
    format: "r8unorm" | "r16unorm" | "r16float",
  ): Promise<void> {
    this.format = format === "r8unorm" ? "u8" : "f16";
  }

  setBrickStaleListener(listener: BrickStaleListener | null): void {
    this.staleListener = listener;
  }

  private rangeSource(): RangeSource {
    if (typeof this.source !== "string") return blobRangeSource(this.source);
    // Retry transient network failures (TypeError "Failed to fetch", 5xx).
    const inner = httpRangeSource(this.source);
    return {
      async read(offset, length, signal) {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            return await inner.read(offset, length, signal);
          } catch (e) {
            lastErr = e;
            if (signal?.aborted) throw e;
            const msg = e instanceof Error ? e.message : String(e);
            if (/HTTP 4\d\d|ignored the HTTP Range/.test(msg)) throw e;
            await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
          }
        }
        throw lastErr;
      },
    };
  }

  /**
   * `src` for metadata reads, which yield to chunk reads: while the chunk
   * fetcher is busy at most META_READS_WHILE_FETCHING run at once (none if
   * only background index reads want them), and otherwise
   * META_READS_IN_BACKGROUND while only background index reads run.
   */
  private yieldingToChunks(src: RangeSource): RangeSource {
    return {
      read: async (offset, length, signal) => {
        while (this.metaReads >= this.metaReadLimit()) {
          await new Promise<void>((go) => this.metaWaiting.push(go));
        }
        this.metaReads++;
        try {
          return await src.read(offset, length, signal);
        } finally {
          this.metaReads--;
          this.metaWaiting.shift()?.();
        }
      },
    };
  }

  private metaReadLimit(): number {
    const background = this.indexReads > 0 && this.urgentIndexWaits === 0;
    if (this.fetcher?.busy) return background ? 0 : META_READS_WHILE_FETCHING;
    return background ? META_READS_IN_BACKGROUND : Infinity;
  }

  /** The limit may have risen: waiting metadata reads check it again. */
  private wakeMetaReads(): void {
    for (const go of this.metaWaiting.splice(0)) go();
  }

  /**
   * Chunk reads are done for now: metadata reads speed up, and the other
   * levels' indexes load in the background.
   */
  private chunksIdle(): void {
    this.wakeMetaReads();
    void this.prefetchIndexes();
  }

  /**
   * While chunk reads are idle, read the other levels' indexes coarse to
   * fine, one index at a time, so a later zoom finds them ready. Stops when
   * chunk reads start again and resumes at the next idle moment.
   */
  private async prefetchIndexes(): Promise<void> {
    const file = this.file;
    if (this.prefetching || !file) return;
    this.prefetching = true;
    try {
      const levels = [...new Set(this.pyramid.map((l) => l.source))].reverse();
      for (const level of levels) {
        for (const channel of this.activeChannels) {
          if (this.file !== file || this.fetcher?.busy) return;
          await this.openDataset(level, channel, true).catch(() => null);
        }
      }
    } finally {
      this.prefetching = false;
    }
  }

  /**
   * The saved chunk index (option `chunkIndex`, else "<url>.index"), read
   * alongside the file's header. Not retried: a missing one costs a request.
   */
  private async openSavedIndex(): Promise<ChunkIndexFile | null> {
    let url = this.options.chunkIndex;
    if (url === undefined && typeof this.source === "string") {
      const u = new URL(this.source, location.href);
      u.pathname += ".index";
      url = u.href;
    }
    if (!url) return null;
    const index = await ChunkIndexFile.open(httpRangeSource(url));
    if (index) this.chunkIndexUrl = url;
    return index;
  }

  /** URL of the saved chunk index in use, once looked for (null: none). */
  async chunkIndexInUse(): Promise<string | null> {
    await this.savedIndex;
    return this.chunkIndexUrl;
  }

  /**
   * A saved chunk index for `channels` (default: all) at every level, to
   * host next to the file as "<file>.ims.index" or pass as `chunkIndex`:
   * viewers then skip reading the file's chunk B-trees.
   */
  async buildChunkIndex(
    channels?: readonly number[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Uint8Array> {
    return buildImsChunkIndex(await this.openFile(), {
      timepoint: this.timepoint,
      channels,
      ...(this.info ? { volume: this.info } : {}),
      onProgress,
    });
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;
    const raw = this.rangeSource();
    this.raw = raw;
    this.meta = cachedRangeSource(this.yieldingToChunks(raw), {
      pageSize: 16 * 1024,
      maxPages: META_PAGES,
    });
    // A saved index that describes the volume spares reading the file's
    // attributes: the file is then first read for voxels.
    this.savedIndex = this.openSavedIndex();
    const saved = await this.savedIndex;
    const described = saved?.timepoint === this.timepoint ? saved.volume : null;
    const info =
      described ??
      (await readImsVolumeInfo(await this.openFile(), this.timepoint));
    const reasons = imsVolumeProblems(info);
    if (reasons.length > 0) throw new UnsupportedDatasetError(reasons);
    this.info = info;
    this.describedByIndex = described !== null;
    this.sourceLevels = info.levels;
    this.allChannels = info.channels;
    const channelCount = info.channels.length;

    const requested = (this.options.channels ?? [])
      .filter((c) => Number.isInteger(c) && c >= 0 && c < channelCount)
      .filter((c, i, arr) => arr.indexOf(c) === i);
    this.activeChannels = (
      requested.length > 0
        ? requested
        : Array.from({ length: channelCount }, (_, i) => i)
    ).slice(0, MAX_CHANNELS);
    if (channelCount > MAX_CHANNELS && requested.length === 0) {
      console.info(
        `[Kiln] IMS has ${channelCount} channels; showing ${MAX_CHANNELS} at a time (choose with the channel picker)`,
      );
    }

    let name = info.name ?? "ims";
    if (name === "ims" && typeof this.source === "string") {
      name = decodeURIComponent(this.source.split("/").pop() ?? "ims");
    } else if (name === "ims" && typeof this.source !== "string") {
      name = this.source.name;
    }

    this.pyramid = planVirtualPyramid(info.levels);
    const active = this.activeChannels.map((c) => this.allChannels[c]!);
    const windowFor = channelWindow;

    this.metadata = {
      name,
      dimensions: info.levels[0]!.dims,
      voxelSpacing: info.voxelSpacing,
      brickSize: LOGICAL_BRICK_SIZE,
      physicalBrickSize: PHYSICAL_BRICK_SIZE,
      maxLod: this.pyramid.length - 1,
      levels: this.pyramid.map((l) => ({
        lod: l.lod,
        dimensions: l.dims,
        brickGrid: l.brickGrid,
        brickCount: l.brickGrid[0] * l.brickGrid[1] * l.brickGrid[2],
      })),
      bitDepth: this.format === "u8" ? 8 : 16,
      window: active[0] ? windowFor(active[0]) : undefined,
      channelWindows: active.map(windowFor),
      channelNames: active.map((c) => c.name),
      channelColors: active.map((c) => c.color),
      numChannels: Math.max(1, active.length),
      isFloat: false,
      compression: info.compression,
      sourceDataType: `${info.dtype.class}${info.dtype.size * 8}`,
    };

    // With the file open anyway, the coarsest level's chunk index now: the
    // base layer needs it first, and an unreadable index fails here rather
    // than on every brick. Workers and the chunk fetcher wait for the first
    // brick (start()), and other levels' indexes for their first brick, so
    // opening stays cheap.
    if (!this.describedByIndex) {
      const coarse = this.pyramid[this.pyramid.length - 1]!.source;
      await Promise.all(
        this.activeChannels.map((c) => this.openDataset(coarse, c)),
      );
    }
    return this.metadata;
  }

  /** The HDF5 file, opened on first use (after `initialize` set up reads). */
  private openFile(): Promise<Hdf5File> {
    if (!this.opening) {
      const raw = this.raw;
      const meta = this.meta;
      if (!raw || !meta) {
        return Promise.reject(new Error("ImarisDataProvider: not initialized"));
      }
      const opening = (async () => {
        // Imaris writes its group/attribute metadata at the head of the
        // file: one up-front read turns ~30 serial round trips into one.
        await meta.read(0, 1024 * 1024).catch(() => undefined);
        const file = await Hdf5File.open(raw, { meta });
        if (this.raw === raw) this.file = file; // not disposed meanwhile
        return file;
      })();
      opening.catch(() => {
        if (this.opening === opening) this.opening = null;
      });
      this.opening = opening;
    }
    return this.opening;
  }

  /** Workers and the chunk fetcher, on the first brick load. */
  private start(): void {
    if (this.fetcher || !this.raw) return;
    // Decoding keeps up with a remote link on a few workers; more only add
    // memory (each has a decoded-chunk cache) and contend for cores. Local
    // files read at disk speed and can use more.
    const remote = typeof this.source === "string";
    const cores = navigator.hardwareConcurrency || 4;
    const n = Math.max(
      1,
      Math.min(
        this.options.workers ?? (remote ? Math.ceil(cores / 2) : cores - 1),
        remote ? 4 : 8,
      ),
    );
    this.fetcher = new ChunkFetcher(this.raw, {
      budgetBytes: remote ? REMOTE_CHUNK_BUDGET : LOCAL_CHUNK_BUDGET,
      persistKey:
        remote && this.options.persistentCache !== false
          ? new URL(this.source as string, location.href).href
          : undefined,
      onFetched: (bytes, requests) => this.tracker.record(bytes, requests),
      onCached: (address) => this.chunkCached(address),
      onIdle: () => this.chunksIdle(),
    });
    const chunkBudget = Math.min(WORKER_CHUNK_BUDGET, DECODED_CHUNK_BUDGET / n);
    for (let i = 0; i < n; i++) {
      const w = createWorker();
      w.onmessage = (e: MessageEvent<ImsBrickResponse | ImsExtractResponse>) =>
        this.onWorkerMessage(e.data);
      w.onerror = (e) => console.error("[Kiln] IMS worker error", e.message);
      w.postMessage({ type: "init", chunkBudget } satisfies ImsInitRequest);
      this.workers.push(w);
      this.load.push(0);
      this.ownerMirror.push(new ByteLru(chunkBudget * 0.9, (b) => b));
    }
  }

  private onWorkerMessage(msg: ImsBrickResponse | ImsExtractResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    this.load[p.worker]!--;
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg);
  }

  private call<T extends ImsBrickResponse | ImsExtractResponse>(
    worker: number,
    msg: ImsExtractRequest | ImsAssembleRequest,
    transfer: Transferable[] = [],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg.id, {
        worker,
        resolve: resolve as (r: ImsBrickResponse | ImsExtractResponse) => void,
        reject,
      });
      this.load[worker]!++;
      this.workers[worker]!.postMessage(msg, transfer);
    });
  }

  /** The worker with the fewest requests outstanding. */
  private leastLoaded(): number {
    let best = 0;
    for (let i = 1; i < this.load.length; i++)
      if (this.load[i]! < this.load[best]!) best = i;
    return best;
  }

  /**
   * Get the sub-region of one chunk (normalised float16) from its owner,
   * sending the compressed bytes only when the owner doesn't have it.
   */
  private async extract(
    idx: DatasetIndex,
    chunk: number,
    region: [number, number, number, number, number, number],
    norm: [number, number],
    signal: AbortSignal | undefined,
    priority: number,
  ): Promise<Uint16Array> {
    const address = idx.address[chunk]!;
    const size = idx.size[chunk]!;
    const w = ownerOf(address, this.workers.length);
    const decodedBytes =
      idx.chunkShape[0] * idx.chunkShape[1] * idx.chunkShape[2] * 2;
    const send = async (withBytes: boolean): Promise<ImsExtractResponse> => {
      let bytes: Uint8Array | null = null;
      if (withBytes) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        bytes = await this.fetcher!.get({ address, size }, signal, priority);
      }
      const msg: ImsExtractRequest = {
        type: "extract",
        id: ++this.requestId,
        address,
        bytes,
        filters: idx.dataset.filters,
        filterMask: idx.filterMask.get(chunk) ?? 0,
        dtype: {
          class: idx.dataset.dtype.class as "int" | "uint" | "float",
          size: idx.dataset.dtype.size,
        },
        chunkShape: idx.chunkShape,
        normLo: norm[0],
        normHi: norm[1],
        region,
      };
      return this.call<ImsExtractResponse>(w, msg);
    };
    let res = await send(!this.ownerMirror[w]!.has(address));
    if (res.missing) {
      this.ownerMirror[w]!.delete(address);
      res = await send(true);
    }
    if (res.error || !res.data)
      throw new Error(res.error ?? "IMS chunk extract failed");
    this.ownerMirror[w]!.set(address, decodedBytes);
    return new Uint16Array(res.data);
  }

  /** `background`: no brick waits on it (see prefetchIndexes). */
  private openDataset(
    level: number,
    channel: number,
    background = false,
  ): Promise<DatasetIndex> {
    const key = `${level}:${channel}`;
    let p = this.datasetIndex.get(key);
    if (!p) {
      // Index pages are read once: the page cache is large only while
      // indexes load.
      if (this.indexReads++ === 0) this.meta?.setMaxPages(META_PAGES);
      p = (async () => {
        const file = await this.openFile();
        const ds = await file.get(
          `/DataSet/ResolutionLevel ${level}/TimePoint ${this.timepoint}/Channel ${channel}/Data`,
        );
        if (!(ds instanceof Hdf5Dataset)) {
          throw new Error(
            `IMS dataset missing for level ${level} channel ${channel}`,
          );
        }
        const saved = await this.savedIndex;
        // Its levels and channels came from the index: they must be this file's.
        if (this.describedByIndex && saved?.changed(level, channel, ds)) {
          throw new Error(
            `${this.chunkIndexUrl} was built for another version of the volume: rebuild it`,
          );
        }
        // The saved table, if it matches the dataset; else its B-tree.
        const table =
          (await saved
            ?.table(level, channel, this.timepoint, ds)
            .catch(() => null)) ?? (await readChunkTable(ds));
        this.indexReady.add(key);
        return { dataset: ds, ...table };
      })().finally(() => {
        if (--this.indexReads === 0) {
          this.meta?.setMaxPages(META_PAGES_AFTER_INDEX);
        }
      });
      p.catch(() => this.datasetIndex.delete(key));
      this.datasetIndex.set(key, p);
    }
    if (background || this.indexReady.has(key)) return p;
    // A brick waits on it: its reads aren't capped unless chunks are busy.
    if (this.urgentIndexWaits++ === 0) this.wakeMetaReads();
    return p.finally(() => {
      this.urgentIndexWaits--;
    });
  }

  getMetadata(): VolumeMetadata {
    if (!this.metadata)
      throw new Error("Metadata not loaded. Call initialize() first.");
    return this.metadata;
  }

  getBrickGrid(lod: number): [number, number, number] {
    const level = this.pyramid[lod];
    if (!level) throw new Error(`LOD level ${lod} not found`);
    return level.brickGrid;
  }

  async loadBrick(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    channelIndex = 0,
    signal?: AbortSignal,
    priority = 0,
  ): Promise<BrickLoadResult | null> {
    const level = this.pyramid[lod];
    const channel = this.activeChannels[channelIndex];
    if (!this.metadata || !level || channel === undefined) return null;
    const [gx, gy, gz] = level.brickGrid;
    if (bx < 0 || by < 0 || bz < 0 || bx >= gx || by >= gy || bz >= gz)
      return null;
    this.start();

    try {
      const idx = await this.openDataset(level.source, channel);
      const src = this.sourceLevels.find((s) => s.index === level.source)!;
      let sx = axisSampling(bx, level.dims[0], src.dims[0], level.ratio[0]);
      let sy = axisSampling(by, level.dims[1], src.dims[1], level.ratio[1]);
      let sz = axisSampling(bz, level.dims[2], src.dims[2], level.ratio[2]);
      // Ghost faces that would pull in uncached, border-only chunks are
      // edge-clamped for now (missing edge / corner chunks clamp-filled);
      // the brick is reported stale once they arrive for their own bricks.
      // Not on the base level: it loads every brick at once (so neighbours
      // arrive anyway), outside the streaming manager's stale tracking.
      let plan: BorderPlan | null = null;
      if (lod < this.pyramid.length - 1) {
        plan = planBorders([sx, sy, sz], idx.chunkShape, (cx, cy, cz) =>
          this.isCached(idx, chunkIndex(idx, cx, cy, cz)),
        );
        const c = plan.clamped;
        if (c & faceBit(0, 0)) sx = clampGhost(sx, 0);
        if (c & faceBit(0, 1)) sx = clampGhost(sx, 1);
        if (c & faceBit(1, 0)) sy = clampGhost(sy, 0);
        if (c & faceBit(1, 1)) sy = clampGhost(sy, 1);
        if (c & faceBit(2, 0)) sz = clampGhost(sz, 0);
        if (c & faceBit(2, 1)) sz = clampGhost(sz, 1);
      }
      const lo: Vec3 = [sx.lo, sy.lo, sz.lo];
      const hi: Vec3 = [sx.hi, sy.hi, sz.hi];
      const P = PHYSICAL_BRICK_SIZE;
      const info = this.allChannels[channel]!;
      const norm: [number, number] = [info.range[0], info.range[1]];
      const t0 = performance.now();
      const jobs: Array<Promise<ImsPiece>> = [];
      const fills: Array<[number, number, number, number, number, number]> = [];
      const unfetched = new Set(
        plan?.filled.map(([cx, cy, cz]) => chunkIndex(idx, cx, cy, cz)),
      );
      const [csx, csy, csz] = idx.chunkShape;
      for (const [cx, cy, cz] of overlappingChunks(lo, hi, idx.chunkShape)) {
        const index = chunkIndex(idx, cx, cy, cz);
        if (!(idx.address[index]! >= 0)) continue; // unallocated → zeros
        const x0 = Math.max(lo[0], cx * csx);
        const y0 = Math.max(lo[1], cy * csy);
        const z0 = Math.max(lo[2], cz * csz);
        const x1 = Math.min(hi[0], (cx + 1) * csx);
        const y1 = Math.min(hi[1], (cy + 1) * csy);
        const z1 = Math.min(hi[2], (cz + 1) * csz);
        if (unfetched.has(index)) {
          fills.push([x0, y0, z0, x1, y1, z1]);
          continue;
        }
        const region: [number, number, number, number, number, number] = [
          x0 - cx * csx,
          y0 - cy * csy,
          z0 - cz * csz,
          x1 - cx * csx,
          y1 - cy * csy,
          z1 - cz * csz,
        ];
        jobs.push(
          this.extract(idx, index, region, norm, signal, priority).then(
            (data) => ({
              x0,
              y0,
              z0,
              sx: x1 - x0,
              sy: y1 - y0,
              sz: z1 - z0,
              data,
            }),
          ),
        );
      }
      if (jobs.length === 0) {
        const empty = { min: 0, max: 0, avg: 0 };
        this.cacheBrickStats(lod, bx, by, bz, channelIndex, empty);
        return {
          data:
            this.format === "u8"
              ? new Uint8Array(P * P * P)
              : new Uint16Array(P * P * P),
          ...empty,
        };
      }
      const pieces = await Promise.all(jobs);
      if (signal?.aborted) return null;
      const tPieces = performance.now();
      const result = await this.call<ImsBrickResponse>(
        this.leastLoaded(),
        {
          type: "assemble",
          id: ++this.requestId,
          pieces,
          lo,
          hi,
          fills,
          rx: sx.ranges,
          ry: sy.ranges,
          rz: sz.ranges,
          format: this.format,
        },
        pieces.map((p) => p.data.buffer as ArrayBuffer),
      );
      if (result.error || !result.data)
        throw new Error(result.error ?? "IMS brick assembly failed");
      this.fetchAvg.add(tPieces - t0);
      this.assemblyAvg.add(result.assemblyMs);
      this.queueAvg.add(performance.now() - tPieces - result.assemblyMs);
      const brickStats = { min: result.min, max: result.max, avg: result.avg };
      this.cacheBrickStats(lod, bx, by, bz, channelIndex, brickStats);
      const data =
        this.format === "u8"
          ? new Uint8Array(result.data)
          : new Uint16Array(result.data);
      this.watchClamped({ lod, bx, by, bz, channelIndex }, idx, plan);
      return { data, ...brickStats };
    } catch (e) {
      if (signal?.aborted) return null;
      if (e instanceof Error && e.message === "cancelled") return null;
      console.warn(
        `[Kiln] IMS brick lod${lod}:${bx}-${by}-${bz} ch${channelIndex} failed:`,
        e,
      );
      return null;
    }
  }

  /**
   * Chunk `i` needs no network: unallocated, held decoded by its worker, or
   * its bytes are in memory or on disk.
   */
  private isCached(idx: DatasetIndex, i: number): boolean {
    const address = idx.address[i]!;
    if (!(address >= 0)) return true;
    const w = ownerOf(address, this.workers.length);
    return (
      !!this.ownerMirror[w]?.has(address) ||
      !!this.fetcher?.has(address, idx.size[i]!)
    );
  }

  /**
   * Remember which chunks a just-assembled brick channel lacked for its
   * ghost border (replacing what an earlier load of it recorded).
   */
  private watchClamped(
    brick: Omit<ClampedBrick, "key" | "waiting">,
    idx: DatasetIndex,
    plan: BorderPlan | null,
  ): void {
    const key = `${brick.lod}:${brick.bx}/${brick.by}/${brick.bz}:${brick.channelIndex}`;
    this.unwatchClamped(key);
    if (!plan || plan.waiting.length === 0) return;
    const rec: ClampedBrick = { ...brick, key, waiting: [] };
    for (const chunks of plan.waiting) {
      const addresses = new Set<number>();
      for (const [cx, cy, cz] of chunks) {
        const i = chunkIndex(idx, cx, cy, cz);
        // May have arrived while this brick loaded.
        if (!this.isCached(idx, i)) addresses.add(idx.address[i]!);
      }
      rec.waiting.push(addresses);
    }
    if (rec.waiting.some((a) => a.size === 0)) {
      this.markStale(rec);
      return;
    }
    this.clamped.set(key, rec);
    for (const addresses of rec.waiting) {
      for (const a of addresses) {
        let recs = this.waitingOn.get(a);
        if (!recs) {
          recs = new Set();
          this.waitingOn.set(a, recs);
        }
        recs.add(rec);
      }
    }
    if (this.clamped.size > MAX_CLAMPED) {
      const oldest = this.clamped.values().next().value!;
      this.unwatchClamped(oldest.key);
      this.markStale(oldest);
    }
  }

  private unwatchClamped(key: string): void {
    const rec = this.clamped.get(key);
    if (!rec) return;
    this.clamped.delete(key);
    for (const addresses of rec.waiting) {
      for (const a of addresses) {
        const recs = this.waitingOn.get(a);
        recs?.delete(rec);
        if (recs?.size === 0) this.waitingOn.delete(a);
      }
    }
  }

  /** A chunk arrived: bricks with a waiting group now complete are stale. */
  private chunkCached(address: number): void {
    const recs = this.waitingOn.get(address);
    if (!recs) return;
    this.waitingOn.delete(address);
    for (const rec of recs) {
      let complete = false;
      for (const addresses of rec.waiting) {
        if (addresses.delete(address) && addresses.size === 0) complete = true;
      }
      if (complete) {
        this.unwatchClamped(rec.key);
        this.markStale(rec);
      }
    }
  }

  private markStale(rec: ClampedBrick): void {
    this.stale.push(rec);
    this.staleTimer ??= setTimeout(() => {
      this.staleTimer = null;
      const recs = this.stale;
      this.stale = [];
      for (const r of recs)
        this.staleListener?.(r.lod, r.bx, r.by, r.bz, r.channelIndex);
    }, STALE_NOTIFY_MS);
  }

  /**
   * Point channel slot `slot` at file channel `channel` in place of
   * reopening (after `initialize`). The slot's bricks must be reloaded:
   * `KilnViewer.setChannelSource` does both. False when either is out of
   * range.
   */
  setChannelSource(slot: number, channel: number): boolean {
    const meta = this.metadata;
    const info = this.allChannels[channel];
    if (!meta || !info || slot < 0 || slot >= this.activeChannels.length) {
      return false;
    }
    if (this.activeChannels[slot] === channel) return true;
    this.activeChannels[slot] = channel;
    // What was learned about the old channel's bricks no longer holds.
    for (const perChannel of this.brickStatsCache.values()) {
      perChannel[slot] = undefined;
    }
    if (meta.channelWindows) meta.channelWindows[slot] = channelWindow(info);
    if (meta.channelNames) meta.channelNames[slot] = info.name;
    if (meta.channelColors) meta.channelColors[slot] = info.color;
    if (slot === 0) meta.window = channelWindow(info);
    return true;
  }

  /**
   * A channel's histogram as Imaris stored it (`Channel N/Histogram` at full
   * resolution: 256 bins over HistogramMin–HistogramMax), or null when the
   * file has none. `channel` is a file channel index (see `allChannels`);
   * call after `initialize`.
   */
  async channelHistogram(channel: number): Promise<ImsChannelHistogram | null> {
    const level = this.sourceLevels[0]?.index;
    if (level === undefined) return null;
    const file = await this.openFile();
    const path = `/DataSet/ResolutionLevel ${level}/TimePoint ${this.timepoint}/Channel ${channel}`;
    const group = await file.get(path);
    if (!(group instanceof Hdf5Group)) return null;
    const ds = await group.get("Histogram");
    if (!(ds instanceof Hdf5Dataset) || ds.dtype.class !== "uint") return null;
    const attrs = await group.attrs();
    const min = attrNumber(attrs.HistogramMin);
    const max = attrNumber(attrs.HistogramMax);
    if (min === undefined || max === undefined || !(max > min)) return null;
    const bytes = await ds.readBytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = ds.dtype.size;
    const counts: number[] = [];
    for (let o = 0; o + size <= bytes.byteLength; o += size) {
      counts.push(
        size === 8
          ? Number(view.getBigUint64(o, true))
          : size === 4
            ? view.getUint32(o, true)
            : size === 2
              ? view.getUint16(o, true)
              : view.getUint8(o),
      );
    }
    return { counts, min, max };
  }

  async isBrickEmpty(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    maxThreshold?: number,
    channels?: readonly number[],
  ): Promise<boolean> {
    // Judged per channel: one channel's stats say nothing about another's.
    const slots = channels ?? this.activeChannels.map((_, slot) => slot);
    if (slots.length === 0) return false;
    return slots.every((slot) =>
      imsBrickIsEmpty({
        lod,
        bx,
        by,
        bz,
        maxLod: this.metadata?.maxLod ?? lod,
        threshold: maxThreshold ?? 1,
        getStats: (l, x, y, z) =>
          this.brickStatsCache.get(`${l}:${x}/${y}/${z}`)?.[slot] ?? null,
      }),
    );
  }

  getNetworkStats(): NetworkStats {
    return this.tracker.getStats();
  }

  getPipelineTimings(): ProviderTimings {
    return {
      avgQueueMs: this.queueAvg.value,
      avgFetchMs: this.fetchAvg.value,
      avgAssemblyMs: this.assemblyAvg.value,
      sampleCount: this.fetchAvg.count,
    };
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.ownerMirror = [];
    this.load = [];
    this.fetcher?.dispose();
    this.fetcher = null;
    for (const p of this.pending.values()) p.reject(new Error("cancelled"));
    this.pending.clear();
    this.brickStatsCache.clear();
    this.datasetIndex.clear();
    this.clamped.clear();
    this.waitingOn.clear();
    this.stale = [];
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = null;
    this.staleListener = null;
    this.metadata = null;
    this.info = null;
    this.file = null;
    this.opening = null;
    this.raw = null;
    this.meta = null;
  }

  private cacheBrickStats(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    channel: number,
    stats: BrickStats,
  ): void {
    const key = `${lod}:${bx}/${by}/${bz}`;
    const perChannel = this.brickStatsCache.get(key) ?? [];
    perChannel[channel] = stats;
    this.brickStatsCache.set(key, perChannel);
    while (this.brickStatsCache.size > MAX_STATS_ENTRIES) {
      const oldest = this.brickStatsCache.keys().next().value;
      if (oldest === undefined) break;
      this.brickStatsCache.delete(oldest);
    }
  }
}
