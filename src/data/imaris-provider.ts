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
  type Hdf5AttrValue,
  Hdf5Dataset,
  Hdf5File,
  Hdf5Group,
  httpRangeSource,
  type RangeSource,
} from "./hdf5/index.js";
import { ChunkFetcher } from "./imaris/chunk-fetcher.js";
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
import { NetworkTracker, RollingAvg } from "./network-tracker.js";

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
/** Clamped brick channels watched for their missing chunks (oldest dropped). */
const MAX_CLAMPED = 65_536;
/** Stale-brick reports are batched over this long. */
const STALE_NOTIFY_MS = 100;

/** One channel as described by the file (all channels, not just active ones). */
export interface ImsChannelInfo {
  index: number;
  name: string;
  /** Display colour, linear 0–1 */
  color: [number, number, number];
  /** Normalisation range used for this channel (raw units) */
  range: [number, number];
  /** Imaris display range (raw units) */
  displayRange: [number, number] | null;
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

function attrString(v: Hdf5AttrValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v.replace(/\0+$/, "").trim();
  if (Array.isArray(v)) return v.map(String).join("").trim();
  return String(v);
}

function attrNumber(v: Hdf5AttrValue | undefined): number | undefined {
  const s = attrString(v);
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function attrNumbers(v: Hdf5AttrValue | undefined): number[] | undefined {
  const s = attrString(v);
  if (!s) return undefined;
  const parts = s
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  return parts.length > 0 && parts.every(Number.isFinite) ? parts : undefined;
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
interface DatasetIndex {
  dataset: Hdf5Dataset;
  /** chunk shape [x, y, z] */
  chunkShape: Vec3;
  /** chunk grid [x, y, z] */
  grid: Vec3;
  /** File address per chunk; -1 when unallocated (reads as zeros) */
  address: Float64Array;
  /** Stored (compressed) bytes per chunk */
  size: Uint32Array;
  /** The rare non-zero filter masks */
  filterMask: Map<number, number>;
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
  private readonly brickStatsCache = new Map<string, BrickStats>();
  private readonly datasetIndex = new Map<string, Promise<DatasetIndex>>();
  /** Chunk indexes being read (the metadata page cache is large meanwhile). */
  private indexReads = 0;
  /** Metadata reads in flight, and those waiting for chunk reads to ease. */
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

  /** Every channel in the file (names, colours, ranges). */
  allChannels: ImsChannelInfo[] = [];
  /** Source channel index for each active slot. */
  activeChannels: number[] = [];

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
   * fetcher is busy, at most META_READS_WHILE_FETCHING run at once.
   */
  private yieldingToChunks(src: RangeSource): RangeSource {
    return {
      read: async (offset, length, signal) => {
        while (
          this.fetcher?.busy &&
          this.metaReads >= META_READS_WHILE_FETCHING
        ) {
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

  /** Chunk reads are done for now: waiting metadata reads may all start. */
  private chunksIdle(): void {
    for (const go of this.metaWaiting.splice(0)) go();
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;
    const raw = this.rangeSource();
    const meta = cachedRangeSource(this.yieldingToChunks(raw), {
      pageSize: 16 * 1024,
      maxPages: META_PAGES,
    });
    this.raw = raw;
    this.meta = meta;
    // Imaris writes its group/attribute metadata at the head of the file:
    // one up-front read turns ~30 serial round trips into one.
    await meta.read(0, 1024 * 1024).catch(() => undefined);
    const file = await Hdf5File.open(raw, { meta });
    this.file = file;

    const reasons: string[] = [];
    const dataSet = await file.get("/DataSet");
    if (!(dataSet instanceof Hdf5Group)) {
      throw new UnsupportedDatasetError([
        "Not an Imaris 5.5 file (missing /DataSet group)",
      ]);
    }
    const levelNames = (await dataSet.keys())
      .map((k) => ({ k, m: /^Resolution ?Level (\d+)$/.exec(k) }))
      .filter((e) => e.m)
      .sort((a, b) => Number(a.m![1]) - Number(b.m![1]));
    const tp = `TimePoint ${this.timepoint}`;

    // Source levels (ImageSize attrs of channel 0)
    const sources: SourceLevel[] = [];
    const ch0Attrs: Array<Record<string, Hdf5AttrValue>> = [];
    const levelAttrs = await Promise.all(
      levelNames.map(async ({ k }) => {
        const g = await file.get(`/DataSet/${k}/${tp}/Channel 0`);
        return g instanceof Hdf5Group ? g.attrs() : null;
      }),
    );
    for (let i = 0; i < levelNames.length; i++) {
      const a = levelAttrs[i];
      if (!a) break;
      const x = attrNumber(a.ImageSizeX);
      const y = attrNumber(a.ImageSizeY);
      const z = attrNumber(a.ImageSizeZ);
      if (!x || !y || !z) break;
      sources.push({ index: Number(levelNames[i]!.m![1]), dims: [x, y, z] });
      ch0Attrs.push(a);
    }
    if (sources.length === 0) {
      throw new UnsupportedDatasetError([
        `IMS file has no ResolutionLevel / ${tp} / Channel 0 data`,
      ]);
    }
    this.sourceLevels = sources;
    if (sources[0]!.dims[2] < 2) {
      reasons.push("IMS volume is not 3D (ImageSizeZ must be greater than 1)");
    }

    const tpGroup = await file.get(`/DataSet/${levelNames[0]!.k}/${tp}`);
    const channelCount =
      tpGroup instanceof Hdf5Group
        ? (await tpGroup.keys()).filter((k) => /^Channel \d+$/.test(k)).length
        : 1;

    // Header only: the chunk index is read lazily, per level, on first use.
    const probe = await file.get(
      `/DataSet/ResolutionLevel ${sources[0]!.index}/TimePoint ${this.timepoint}/Channel 0/Data`,
    );
    if (!(probe instanceof Hdf5Dataset)) {
      throw new Error("IMS dataset missing for the finest level");
    }
    const dt = probe.dtype;
    if (
      !(
        (dt.class === "uint" && (dt.size === 1 || dt.size === 2)) ||
        (dt.class === "int" && dt.size === 2) ||
        (dt.class === "float" && dt.size === 4)
      ) ||
      !dt.littleEndian
    ) {
      reasons.push(
        `Data type ${dt.class}${dt.size * 8}${dt.littleEndian ? "" : " (big-endian)"} is not supported`,
      );
    }
    if (reasons.length > 0) throw new UnsupportedDatasetError(reasons);

    // Channel descriptions
    const info = await file.get("/DataSetInfo");
    const infoGroup = info instanceof Hdf5Group ? info : null;
    const typeMax = dt.class === "float" ? 1 : 2 ** (dt.size * 8) - 1;
    this.allChannels = await Promise.all(
      Array.from({ length: channelCount }, async (_, c) => {
        const levelAttrs: Record<string, Hdf5AttrValue> =
          c === 0
            ? ch0Attrs[0]!
            : await (async () => {
                const g = await file.get(
                  `/DataSet/${levelNames[0]!.k}/${tp}/Channel ${c}`,
                );
                return g instanceof Hdf5Group ? g.attrs() : {};
              })();
        const infoCh = infoGroup ? await infoGroup.get(`Channel ${c}`) : null;
        const ia = infoCh instanceof Hdf5Group ? await infoCh.attrs() : {};
        const hMin = attrNumber(levelAttrs.HistogramMin);
        const hMax = attrNumber(levelAttrs.HistogramMax);
        let lo = hMin ?? 0;
        let hi = hMax ?? typeMax;
        if (dt.class !== "float") lo = Math.max(0, lo);
        if (!(hi > lo)) hi = lo + 1;
        const rgb = attrNumbers(ia.Color);
        const color: [number, number, number] =
          rgb && rgb.length >= 3
            ? [
                Math.min(1, Math.max(0, rgb[0]!)),
                Math.min(1, Math.max(0, rgb[1]!)),
                Math.min(1, Math.max(0, rgb[2]!)),
              ]
            : [1, 1, 1];
        const cr = attrNumbers(ia.ColorRange);
        const name = attrString(ia.Name);
        return {
          index: c,
          name: name && name !== "(name not specified)" ? name : `Channel ${c}`,
          color,
          range: [lo, hi] as [number, number],
          displayRange:
            cr && cr.length >= 2
              ? ([cr[0]!, cr[1]!] as [number, number])
              : null,
        };
      }),
    );

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

    // Geometry
    let voxelSpacing: [number, number, number] | undefined;
    let name = "ims";
    const image = infoGroup ? await infoGroup.get("Image") : null;
    if (image instanceof Hdf5Group) {
      const a = await image.attrs();
      const [sx, sy, sz] = sources[0]!.dims;
      const ext = (i: number) => {
        const lo = attrNumber(a[`ExtMin${i}`]);
        const hi = attrNumber(a[`ExtMax${i}`]);
        return lo !== undefined && hi !== undefined
          ? Math.abs(hi - lo)
          : undefined;
      };
      const dx = ext(0);
      const dy = ext(1);
      const dz = ext(2);
      if (dx && dy && dz) voxelSpacing = [dx / sx, dy / sy, dz / sz];
      const n = attrString(a.Name);
      if (n && n !== "(name not specified)") name = n;
    }
    if (name === "ims" && typeof this.source === "string") {
      name = decodeURIComponent(this.source.split("/").pop() ?? "ims");
    } else if (name === "ims" && typeof this.source !== "string") {
      name = this.source.name;
    }

    this.pyramid = planVirtualPyramid(sources);
    const active = this.activeChannels.map((c) => this.allChannels[c]!);
    // Windows in raw data units over the normalisation range; the viewer maps
    // them to the normalised [0, 1] atlas values.
    const windowFor = (ch: ImsChannelInfo) => {
      const [lo, hi] = ch.range;
      const [a, b] = ch.displayRange ?? ch.range;
      const start = Math.min(hi, Math.max(lo, a));
      const end = Math.min(hi, Math.max(start + (hi - lo) * 1e-3, b));
      return { start, end, min: lo, max: hi };
    };

    this.metadata = {
      name,
      dimensions: sources[0]!.dims,
      voxelSpacing,
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
      compression: probe.filters.map((f) => f.name).join("+") || "none",
      sourceDataType: `${dt.class}${dt.size * 8}`,
    };

    // The coarsest level's chunk index now: the base layer needs it first,
    // and an unreadable index fails here rather than on every brick.
    // Workers and the chunk fetcher wait for the first brick (start()), and
    // other levels' indexes for their first brick, so opening stays cheap.
    const coarse = this.pyramid[this.pyramid.length - 1]!.source;
    await Promise.all(
      this.activeChannels.map((c) => this.openDataset(coarse, c)),
    );
    return this.metadata;
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

  private openDataset(level: number, channel: number): Promise<DatasetIndex> {
    const key = `${level}:${channel}`;
    let p = this.datasetIndex.get(key);
    if (!p) {
      // Index pages are read once: the page cache is large only while
      // indexes load.
      if (this.indexReads++ === 0) this.meta?.setMaxPages(META_PAGES);
      p = (async () => {
        const file = this.file!;
        const ds = await file.get(
          `/DataSet/ResolutionLevel ${level}/TimePoint ${this.timepoint}/Channel ${channel}/Data`,
        );
        if (!(ds instanceof Hdf5Dataset)) {
          throw new Error(
            `IMS dataset missing for level ${level} channel ${channel}`,
          );
        }
        const cs = ds.chunkShape ?? ds.shape;
        const chunkShape: Vec3 = [cs[2]!, cs[1]!, cs[0]!];
        const grid: Vec3 = [
          Math.ceil(ds.shape[2]! / chunkShape[0]),
          Math.ceil(ds.shape[1]! / chunkShape[1]),
          Math.ceil(ds.shape[0]! / chunkShape[2]),
        ];
        const n = grid[0] * grid[1] * grid[2];
        const idx: DatasetIndex = {
          dataset: ds,
          chunkShape,
          grid,
          address: new Float64Array(n).fill(-1),
          size: new Uint32Array(n),
          filterMask: new Map(),
        };
        if (ds.chunkShape) {
          for (const ref of await ds.chunks()) {
            const i = chunkIndex(
              idx,
              Math.floor(ref.offset[2]! / chunkShape[0]),
              Math.floor(ref.offset[1]! / chunkShape[1]),
              Math.floor(ref.offset[0]! / chunkShape[2]),
            );
            if (i >= n) continue;
            idx.address[i] = ref.address;
            idx.size[i] = ref.size;
            if (ref.filterMask !== 0) idx.filterMask.set(i, ref.filterMask);
          }
        }
        return idx;
      })().finally(() => {
        if (--this.indexReads === 0) {
          this.meta?.setMaxPages(META_PAGES_AFTER_INDEX);
        }
      });
      p.catch(() => this.datasetIndex.delete(key));
      this.datasetIndex.set(key, p);
    }
    return p;
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
        this.cacheBrickStats(lod, bx, by, bz, empty);
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
      this.cacheBrickStats(lod, bx, by, bz, brickStats);
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

  async isBrickEmpty(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    maxThreshold?: number,
  ): Promise<boolean> {
    return imsBrickIsEmpty({
      lod,
      bx,
      by,
      bz,
      maxLod: this.metadata?.maxLod ?? lod,
      threshold: maxThreshold ?? 1,
      getStats: (l, x, y, z) =>
        this.brickStatsCache.get(`${l}:${x}/${y}/${z}`) ?? null,
    });
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
    this.file = null;
    this.raw = null;
    this.meta = null;
  }

  private cacheBrickStats(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    stats: BrickStats,
  ): void {
    const key = `${lod}:${bx}/${by}/${bz}`;
    const existing = this.brickStatsCache.get(key);
    this.brickStatsCache.set(
      key,
      existing
        ? {
            min: Math.min(existing.min, stats.min),
            max: Math.max(existing.max, stats.max),
            avg: Math.max(existing.avg, stats.avg),
          }
        : stats,
    );
    while (this.brickStatsCache.size > MAX_STATS_ENTRIES) {
      const oldest = this.brickStatsCache.keys().next().value;
      if (oldest === undefined) break;
      this.brickStatsCache.delete(oldest);
    }
  }
}
