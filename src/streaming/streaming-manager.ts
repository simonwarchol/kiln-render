/**
 * StreamingManager - Resident set manager for brick streaming. Selects visible
 * bricks by frustum/LOD, queues priority loads, and cancels stale requests.
 */

import { mat4 } from "wgpu-matrix";
import {
  type Camera,
  extractFrustumPlanes,
  isAABBInFrustum,
} from "../core/camera.js";
import type { DatasetConfig } from "../core/config.js";
import { clipToWorld } from "../core/config.js";
import type { VolumeResources } from "../core/volume-resources.js";
import type {
  BrickLoadResult,
  DataProvider,
  LodLevel,
  PipelineTimings,
  VolumeMetadata,
} from "../data/data-provider.js";
import { RollingAvg } from "../data/network-tracker.js";
import { getFloat16ToFloat32Lut } from "../utils/float16.js";
import { ms, perfCount, perfEvent, perfOn } from "../utils/perf-log.js";
import type { AtlasSlot } from "./atlas-allocator.js";
import { BrickCache } from "./brick-cache.js";

/** Newly committed bricks appear at most this often. */
const RESET_COALESCE_MS = 250;
/** Bricks re-uploaded per task when a hidden channel is shown again. */
const BACKFILL_BATCH = 8;

export interface BrickRequest {
  lod: number;
  bx: number;
  by: number;
  bz: number;
  /**
   * Load priority, lower first: camera distance weighted toward the view
   * centre. Coarse fallbacks for missing fine bricks use −1.
   */
  distance: number;
  key: string;
}

/**
 * Cap an octree desired set to what the atlas can actually hold: every pinned
 * brick plus the closest unpinned candidates. Without this, missing-brick
 * queues sit at 1024 forever once the atlas is full of still-desired residents
 * (they get re-touched every recompute and are never evictable).
 */
export function selectResidentSet(
  candidates: readonly BrickRequest[],
  pinnedKeys: ReadonlySet<string>,
  capacity: number,
): BrickRequest[] {
  const pinned: BrickRequest[] = [];
  const unpinned: BrickRequest[] = [];
  for (const brick of candidates) {
    if (pinnedKeys.has(brick.key)) pinned.push(brick);
    else unpinned.push(brick);
  }
  unpinned.sort((a, b) => a.distance - b.distance);
  const budget = Math.max(0, capacity - pinnedKeys.size);
  if (unpinned.length <= budget) {
    return pinned.length === 0 ? unpinned : pinned.concat(unpinned);
  }
  return pinned.concat(unpinned.slice(0, budget));
}

export interface LoadedBrickInfo {
  slot: AtlasSlot;
  slotIndex: number;
  lod: number;
  bx: number;
  by: number;
  bz: number;
}

export interface StreamingStats {
  desiredCount: number;
  loadedCount: number;
  pendingCount: number;
  atlasUsage: number;
  atlasCapacity: number;
  // Network stats
  totalBytesDownloaded: number;
  bytesPerSecond: number;
  requestCount: number;
  // Timing
  timeToFirstRender: number | null; // ms, null if not yet loaded
  // Evictions since load
  evictedCount: number;
  // Per-stage pipeline timings (rolling avg over last ~32 bricks)
  pipelineTimings: PipelineTimings;
  // Brick lifecycle counters (cumulative)
  bricksDispatched: number;
  bricksCommitted: number;
  bricksCancelled: number;
  bricksDiscarded: number; // fetched but no longer desired (stale-on-arrival)
  // End-to-end latency: dispatch → committed (rolling avg ms)
  avgBrickLatencyMs: number;
}

/** What a channel backfill did (perf logging only). */
interface BackfillStats {
  start: number;
  resident: number;
  loads: number;
  cacheHits: number;
  skipped: number;
}

export class StreamingManager {
  private resources: VolumeResources;
  private onResetAccumulation: () => void;
  private dataProvider: DataProvider;
  private metadata: VolumeMetadata;
  private config: DatasetConfig;

  // Track loaded bricks: key -> { slot, slotIndex }
  private loadedBricks = new Map<string, LoadedBrickInfo>();

  // Track pinned bricks (never evicted, always loaded first)
  private pinnedBricks = new Set<string>();

  // Track empty bricks (so we don't re-check them)
  private emptyBricks = new Set<string>();

  // CPU-side cache of decompressed brick data (avoids re-download after GPU eviction)
  private brickCache: BrickCache;

  baseLodLoaded = false;

  // Timing for first render
  private loadStartTime: number = 0;
  timeToFirstRender: number | null = null;

  // Current desired set (keys) - updated each computeDesiredSet
  private desiredKeys = new Set<string>();
  /** Coarse stand-ins for missing fine bricks in the current desired set. */
  private coarseFallbackKeys = new Set<string>();

  // Priority queue for pending loads (sorted by distance, closest first)
  private loadQueue: BrickRequest[] = [];

  // Currently in-flight requests with AbortControllers
  private inFlightRequests = new Map<string, AbortController>();

  // Cancellation grace period — tracks when each in-flight request first left
  // the desired set. Only abort after CANCEL_GRACE_MS, so requests that briefly
  // leave the desired set (LOD oscillation during gestures) survive and warm
  // the worker chunk cache instead of wasting bandwidth on aborted fetches.
  private inFlightStaleTime = new Map<string, number>();
  private readonly CANCEL_GRACE_MS = 200;

  // Max concurrent brick dispatches (each brick may fan out to N channels)
  private maxConcurrentRequests = 12;

  // Cap on in-flight channel fetches across all bricks — keeps worker pools
  // from queueing 12 bricks × N channels at once.
  private maxConcurrentChannelJobs = 8;
  private activeChannelJobs = 0;
  /** Waiting channel fetches, most urgent (lowest priority) first. */
  private channelJobWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
    priority: number;
  }> = [];

  /** Channels reported stale while their brick's load was in flight. */
  private staleOnArrival = new WeakMap<AbortSignal, Set<number>>();
  /** Latest reload per `ch:key`; an older one finishing late doesn't write. */
  private latestReload = new Map<string, number>();
  private reloadSeq = 0;
  /** Backfills in progress (perf logging only). */
  private perfBackfills = 0;

  // Callback for when base LOD is loaded with brick data
  private onBaseLodLoaded:
    | ((brickData: (Uint8Array | Uint16Array)[]) => void)
    | null = null;

  // Callback for when base LOD derives float/channel ranges
  private onRangesDerived:
    | ((opts: {
        dataRange?: [number, number];
        channelRanges?: Array<{ min: number; max: number }>;
      }) => void)
    | null = null;

  // Bricks remaining in the base-LOD load. Included in pendingCount so the
  // UI spinner is visible from the first frame — previously the base load
  // bypassed loadQueue/inFlightRequests entirely and pending read 0 for the
  // whole initial download.
  private baseLodPending = 0;

  // Frame counter for LRU
  private frameCount = 0;

  // Debounced accumulation reset (wait for streaming to settle)
  private resetAccumulationTimer: number | null = null;

  // GPU upload timing (writeTexture, measured on main thread for all providers)
  private uploadAvg = new RollingAvg();

  // Brick lifecycle telemetry
  private bricksDispatched = 0;
  private bricksCommitted = 0;
  private bricksCancelled = 0;
  private bricksDiscarded = 0;
  private brickLatencyAvg = new RollingAvg();
  private dispatchTimestamps = new Map<string, number>();

  // Screen-Space Error (SSE) threshold in pixels
  // Split to finer LOD when projected voxel error exceeds this value
  // Lower = higher quality, more bricks loaded
  // Higher = lower quality, fewer bricks loaded
  public maxPixelError = 1.5;

  /**
   * Device pixels per CSS pixel of the canvas. Detail is chosen in CSS pixels
   * (a voxel may span `maxPixelError` CSS px): at a device pixel ratio of 2,
   * device-pixel detail asks for one level finer everywhere — 8× the bricks.
   */
  public pixelRatio = 1;

  /**
   * When non-null, force the desired set to this pyramid level (0 = finest,
   * metadata.maxLod = coarsest). `null` restores automatic SSE selection.
   */
  public forcedLod: number | null = null;
  /**
   * Renderer clip box (0–1 per axis), shared by reference. Bricks outside it
   * are never streamed: they would take atlas slots without being drawn.
   */
  public clipBox: { min: ArrayLike<number>; max: ArrayLike<number> } | null =
    null;

  /** Per-channel fetch mask. Hidden channels are not requested on LOD changes. */
  private channelEnabled: boolean[];

  // Camera FOV in radians (must match camera.getProjectionMatrix)
  private readonly cameraFovRad = Math.PI / 4; // 45 degrees

  // Precomputed projection factor (updated each frame)
  private projectionFactor = 0;

  // Max bricks to request at once (prevents runaway loading)
  private maxDesiredBricks = 1024;

  // Suspends load-queue draining when atlas is full; retries on next computeDesiredSet.
  private allocationStalled = false;
  /** Camera is being dragged: new dispatches wait until it settles. */
  private dispatchGated = false;

  // Counts from the last desired-set recompute (see getStats)
  private desiredCount = 0;
  private loadedCount = 0;
  private evictedCount = 0;
  /** Finest LOD in the last desired set (Infinity before the first). */
  private finestDesiredLod = Infinity;

  // Throttle updates (don't recompute every frame)
  private lastUpdateFrame = -1;
  private updateInterval = 10; // frames between full updates

  // Camera movement detection
  private lastCameraVersion = -1;
  private cameraStillFrames = 0;
  private cameraStillThreshold = 5; // Frames of stillness before re-prioritizing

  /**
   * View inputs of the last recompute that left nothing to load. While they
   * are unchanged nothing can change the desired set, so an idle viewer skips
   * the octree walk (NaN: not settled).
   */
  private readonly view = new Float64Array(12);
  private readonly settledView = new Float64Array(12).fill(Number.NaN);

  // Constant for the dataset — cached to avoid Math.max(...levels.map()) per call
  private readonly maxLod: number;
  // lod -> LodLevel, indexed — avoids a linear .find() per visited octree node
  private readonly levelsByLod: LodLevel[];

  constructor(
    resources: VolumeResources,
    dataProvider: DataProvider,
    metadata: VolumeMetadata,
    config: DatasetConfig,
    onResetAccumulation: () => void,
    pageLoadStartTime?: number,
  ) {
    this.resources = resources;
    this.onResetAccumulation = onResetAccumulation;
    this.dataProvider = dataProvider;
    this.metadata = metadata;
    this.config = config;

    this.maxLod = metadata.maxLod;
    this.levelsByLod = [];
    for (const level of metadata.levels) this.levelsByLod[level.lod] = level;

    // Scale concurrent requests and cache budget for multichannel
    const numChannels = resources.numChannels;
    this.channelEnabled = Array.from({ length: numChannels }, () => true);
    this.maxConcurrentRequests = numChannels > 1 ? 12 : 8;
    // Multi-channel: limit channel jobs below brick concurrency so N-way
    // Promise.all per brick cannot flood Imaris(≤4)/Zarr(≤8) worker pools.
    this.maxConcurrentChannelJobs =
      numChannels > 1 ? 8 : this.maxConcurrentRequests;
    // CPU-side brick cache. Capped in total: with many channels a per-channel
    // budget ran into GiBs of JS memory alongside the GPU atlas.
    this.brickCache = new BrickCache(
      Math.min(512, 128 * numChannels) * 1024 * 1024,
    );

    // Use page load start time if provided for true time-to-first-render
    this.loadStartTime = pageLoadStartTime ?? performance.now();

    dataProvider.setBrickStaleListener?.((lod, bx, by, bz, ch) =>
      this.onBrickStale(lod, bx, by, bz, ch),
    );

    // Load coarsest LOD immediately as base layer
    this.loadBaseLod();
  }

  /** Set callback to be invoked when base LOD is loaded with brick data */
  setBaseLodLoadedCallback(
    callback: (brickData: (Uint8Array | Uint16Array)[]) => void,
  ): void {
    this.onBaseLodLoaded = callback;
  }

  /** Set callback for when base LOD derives float/channel ranges */
  setRangesDerivedCallback(
    callback: (opts: {
      dataRange?: [number, number];
      channelRanges?: Array<{ min: number; max: number }>;
    }) => void,
  ): void {
    this.onRangesDerived = callback;
  }

  /** Skip fetching this channel on subsequent brick/LOD loads. Re-enabling backfills resident bricks. */
  setChannelEnabled(ch: number, enabled: boolean): void {
    if (ch < 0 || ch >= this.channelEnabled.length) return;
    if (this.channelEnabled[ch] === enabled) return;
    this.channelEnabled[ch] = enabled;
    if (enabled) void this.backfillChannel(ch);
  }

  /** Fetch a newly-visible channel into every currently resident brick. */
  private async backfillChannel(ch: number): Promise<void> {
    const stats: BackfillStats | undefined = perfOn
      ? {
          start: performance.now(),
          resident: this.loadedBricks.size,
          loads: 0,
          cacheHits: 0,
          skipped: 0,
        }
      : undefined;
    if (stats) this.perfBackfills++;
    const jobs: Promise<void>[] = [];
    let started = 0;
    for (const [key, info] of [...this.loadedBricks]) {
      jobs.push(this.reloadBrickChannel(ch, key, info, stats));
      // Cache hits upload synchronously: yield between small batches rather
      // than writing every resident brick (hundreds of MB) in one task.
      if (++started % BACKFILL_BATCH === 0) {
        await new Promise((r) => setTimeout(r, 0));
        if (!this.channelEnabled[ch]) break;
      }
    }
    await Promise.all(jobs);
    if (stats) {
      this.perfBackfills--;
      perfEvent(
        `backfill slot ${ch}: ${stats.resident} resident bricks → ${stats.loads} loaded from the provider, ${stats.cacheHits} from the CPU cache, ${stats.skipped} skipped, in ${ms(performance.now() - stats.start)}`,
      );
    }
  }

  /**
   * The provider would now assemble this brick channel better (a ghost face
   * was edge-clamped while a neighbour's chunks were missing): drop the
   * cached copy and reload it if resident, or once its in-flight load lands.
   */
  private onBrickStale(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    ch: number,
  ): void {
    const key = `lod${lod}:${bz}/${by}/${bx}`;
    this.brickCache.delete(`ch${ch}:${key}`);
    const inFlight = this.inFlightRequests.get(key);
    if (inFlight) {
      let chs = this.staleOnArrival.get(inFlight.signal);
      if (!chs) {
        chs = new Set();
        this.staleOnArrival.set(inFlight.signal, chs);
      }
      chs.add(ch);
    }
    const info = this.loadedBricks.get(key);
    if (info) void this.reloadBrickChannel(ch, key, info);
  }

  /**
   * Write one channel of a resident brick into its slot, from the CPU cache
   * or the provider. A later reload of the same channel supersedes this one,
   * so stale data finishing late never overwrites fresher.
   */
  private async reloadBrickChannel(
    ch: number,
    key: string,
    info: LoadedBrickInfo,
    stats?: BackfillStats,
  ): Promise<void> {
    if (!this.channelEnabled[ch]) {
      if (stats) stats.skipped++;
      return;
    }
    const cacheKey = `ch${ch}:${key}`;
    const seq = ++this.reloadSeq;
    this.latestReload.set(cacheKey, seq);
    const current = () =>
      this.latestReload.get(cacheKey) === seq &&
      this.loadedBricks.get(key) === info &&
      this.channelEnabled[ch];
    try {
      let data = this.brickCache.get(cacheKey);
      if (!data) {
        let result: BrickLoadResult | null;
        try {
          result = await this.withChannelJob(async () =>
            current()
              ? this.dataProvider.loadBrick(
                  info.lod,
                  info.bx,
                  info.by,
                  info.bz,
                  ch,
                )
              : null,
          );
        } catch {
          if (stats) stats.skipped++;
          return;
        }
        if (!result || !current()) {
          if (stats) stats.skipped++;
          return;
        }
        this.brickCache.put(cacheKey, result.data);
        data = result.data;
        if (stats) stats.loads++;
      } else if (stats) {
        stats.cacheHits++;
      }
      if (!current()) return;
      this.resources.writeBrick(info.slot, ch, data);
      this.scheduleAccumulationReset();
    } finally {
      if (this.latestReload.get(cacheKey) === seq)
        this.latestReload.delete(cacheKey);
    }
  }

  private async acquireChannelJob(
    signal?: AbortSignal,
    priority = 0,
  ): Promise<void> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (this.activeChannelJobs < this.maxConcurrentChannelJobs) {
      this.activeChannelJobs++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const entry: (typeof this.channelJobWaiters)[number] = {
        resolve,
        reject,
        signal,
        priority,
      };
      entry.onAbort = () => {
        const i = this.channelJobWaiters.indexOf(entry);
        if (i >= 0) {
          this.channelJobWaiters.splice(i, 1);
          reject(new DOMException("Aborted", "AbortError"));
        }
      };
      // After every waiter at least as urgent (FIFO among equals).
      let i = this.channelJobWaiters.length;
      while (i > 0 && this.channelJobWaiters[i - 1]!.priority > priority) i--;
      this.channelJobWaiters.splice(i, 0, entry);
      signal?.addEventListener("abort", entry.onAbort, { once: true });
    });
  }

  private releaseChannelJob(): void {
    const next = this.channelJobWaiters.shift();
    if (next) {
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      if (next.signal?.aborted) {
        next.reject(new DOMException("Aborted", "AbortError"));
        this.releaseChannelJob();
        return;
      }
      next.resolve(); // transfer slot — activeChannelJobs unchanged
      return;
    }
    this.activeChannelJobs--;
  }

  private async withChannelJob<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    priority?: number,
  ): Promise<T> {
    await this.acquireChannelJob(signal, priority);
    try {
      return await fn();
    } finally {
      this.releaseChannelJob();
    }
  }

  /**
   * Derive a percentile-clipped (p0.1 / p99.9) float data range from base-LOD
   * bricks using a 65536-entry float16 histogram (no per-voxel Math.pow).
   */
  private computeFloatPercentileRange(
    bricks: Uint16Array[],
    rawMin: number,
    rawMax: number,
  ): [number, number] {
    const range = rawMax - rawMin;
    if (!(range > 0) || bricks.length === 0) return [rawMin, rawMax];

    const lut = getFloat16ToFloat32Lut();

    const BINS = 65536;
    const histogram = new Uint32Array(BINS);
    const invRange = (BINS - 1) / range;
    let total = 0;

    for (const brick of bricks) {
      for (let i = 0; i < brick.length; i++) {
        const v = lut[brick[i]!]!;
        if (!isFinite(v)) continue;
        let bin = ((v - rawMin) * invRange) | 0;
        if (bin < 0) bin = 0;
        else if (bin >= BINS) bin = BINS - 1;
        histogram[bin] = (histogram[bin] ?? 0) + 1;
        total++;
      }
    }
    if (total === 0) return [rawMin, rawMax];

    const loTarget = total * 0.001;
    const hiTarget = total * 0.999;
    let lo = rawMin;
    let hi = rawMax;
    let count = 0;
    let loFound = false;
    for (let b = 0; b < BINS; b++) {
      count += histogram[b]!;
      if (!loFound && count > loTarget) {
        lo = rawMin + (b / BINS) * range;
        loFound = true;
      }
      if (count >= hiTarget) {
        hi = rawMin + ((b + 1) / BINS) * range;
        break;
      }
    }
    return lo < hi ? [lo, hi] : [rawMin, rawMax];
  }

  /** Load and pin the coarsest LOD level with bounded concurrency. */
  private async loadBaseLod(): Promise<void> {
    const t0 = performance.now();
    const maxLod = this.maxLod;
    const level = this.levelsByLod[maxLod];
    if (!level) return;

    const [gridX, gridY, gridZ] = level.brickGrid;
    const numChannels = this.resources.numChannels;

    // Build flat list of all brick coords
    const bricks: { bx: number; by: number; bz: number; key: string }[] = [];
    for (let bz = 0; bz < gridZ; bz++) {
      for (let by = 0; by < gridY; by++) {
        for (let bx = 0; bx < gridX; bx++) {
          bricks.push({ bx, by, bz, key: `lod${maxLod}:${bz}/${by}/${bx}` });
        }
      }
    }

    this.baseLodPending = bricks.length;

    // Center-out ordering: the volume's central content appears first instead
    // of a bottom-up z-slab wipe. Cheap and dramatically better perceived load.
    const ccx = (gridX - 1) / 2,
      ccy = (gridY - 1) / 2,
      ccz = (gridZ - 1) / 2;
    bricks.sort((a, b) => {
      const da = (a.bx - ccx) ** 2 + (a.by - ccy) ** 2 + (a.bz - ccz) ** 2;
      const db = (b.bx - ccx) ** 2 + (b.by - ccy) ** 2 + (b.bz - ccz) ** 2;
      return da - db;
    });

    const concurrency = Math.min(bricks.length, this.maxConcurrentRequests);
    console.log(
      `[Kiln] loadBaseLod: ${bricks.length} bricks × ${numChannels} channels (concurrency: ${concurrency})`,
    );

    // Process bricks with bounded concurrency — avoids firing all N×channels network
    // requests simultaneously, which saturates the browser's HTTP connection pool.
    // Uses an async worker-pool pattern: spawn `concurrency` runners that each pull
    // from the shared queue until empty.
    const allBrickData: (Uint8Array | Uint16Array)[] = [];
    let firstBrickMs: number | null = null;
    let sumIsEmptyMs = 0,
      sumFetchMs = 0,
      sumUploadMs = 0,
      brickCount = 0;

    // Range accumulators — derive float data range and per-channel
    // min/max incrementally from BrickLoadResult stats during base LOD loading.
    const isFloat = this.metadata.isFloat ?? false;
    const needsFloatRange = isFloat && !this.metadata.window; // no OMERO → provisional
    const needsChannelRanges = numChannels > 1 && !this.metadata.channelWindows;
    let floatRangeMin = Infinity,
      floatRangeMax = -Infinity;
    const channelMins = needsChannelRanges
      ? (new Array(numChannels).fill(Infinity) as number[])
      : [];
    const channelMaxs = needsChannelRanges
      ? (new Array(numChannels).fill(-Infinity) as number[])
      : [];

    const queue = [...bricks];

    const processBrick = async ({ bx, by, bz, key }: (typeof bricks)[0]) => {
      try {
        const tIsEmpty = performance.now();
        const isEmpty = await this.dataProvider.isBrickEmpty(
          maxLod,
          bx,
          by,
          bz,
          this.config.emptyBrickThreshold,
        );
        sumIsEmptyMs += performance.now() - tIsEmpty;

        if (isEmpty) {
          this.emptyBricks.add(key);
          this.resources.indirection.setEmpty(bx, by, bz, maxLod);
          return;
        }

        // Load channels in parallel — gated by channel-job semaphore
        const tFetch = performance.now();
        const channelResults = await Promise.all(
          Array.from({ length: numChannels }, (_, ch) =>
            this.withChannelJob(() =>
              this.dataProvider.loadBrick(maxLod, bx, by, bz, ch),
            ),
          ),
        );
        sumFetchMs += performance.now() - tFetch;

        if (!channelResults[0]) return; // ch0 mandatory; skip brick entirely if it failed

        // Accumulate per-channel stats for range derivation
        for (let ch = 0; ch < numChannels; ch++) {
          const r = channelResults[ch];
          if (!r) continue;
          if (
            needsFloatRange &&
            r.rawMin !== undefined &&
            r.rawMax !== undefined
          ) {
            if (r.rawMin < floatRangeMin) floatRangeMin = r.rawMin;
            if (r.rawMax > floatRangeMax) floatRangeMax = r.rawMax;
          }
          if (needsChannelRanges) {
            // For non-float: stats are in native [0, 255] or [0, 65535] space.
            // For float: use raw min/max (stats are normalized to provisional range).
            const chMin = isFloat ? (r.rawMin ?? r.min) : r.min;
            const chMax = isFloat ? (r.rawMax ?? r.max) : r.max;
            if (chMin < channelMins[ch]!) channelMins[ch] = chMin;
            if (chMax > channelMaxs[ch]!) channelMaxs[ch] = chMax;
          }
        }

        const result = this.resources.allocator.allocate(this.frameCount);
        if (!result) {
          console.warn("[Kiln] loadBaseLod: atlas allocation failed");
          return;
        }

        const tUpload = performance.now();
        for (let ch = 0; ch < numChannels; ch++) {
          // Zero-fill failed channels. The "fresh from free list" assumption is
          // only true on cold load — after clear() the allocator recycles slots
          // without re-zeroing texture memory, so skipping would show the
          // previous dataset's data in that channel.
          if (this.channelEnabled[ch])
            this.resources.writeBrick(
              result.slot,
              ch,
              channelResults[ch]?.data ?? null,
            );
          else this.resources.clearChannel(result.slot, ch);
        }
        const uploadMs = performance.now() - tUpload;
        sumUploadMs += uploadMs;
        this.uploadAvg.add(uploadMs);

        this.resources.indirection.setBrick(
          bx,
          by,
          bz,
          result.slot.x,
          result.slot.y,
          result.slot.z,
          maxLod,
        );
        this.resources.allocator.setMetadata(result.slotIndex, {
          lod: maxLod,
          bx,
          by,
          bz,
          key,
        });
        this.resources.allocator.pin(result.slotIndex);

        this.loadedBricks.set(key, {
          slot: result.slot,
          slotIndex: result.slotIndex,
          lod: maxLod,
          bx,
          by,
          bz,
        });
        this.pinnedBricks.add(key);
        allBrickData.push(channelResults[0].data);
        brickCount++;

        if (firstBrickMs === null) {
          firstBrickMs = performance.now() - this.loadStartTime;
        }

        // arriving base bricks must trigger a re-render — otherwise the
        // viewer converges on a near-empty scene and freezes while the base LOD
        // silently streams in. The 100 ms debounce coalesces the burst.
        this.scheduleAccumulationReset();
      } finally {
        this.baseLodPending = Math.max(0, this.baseLodPending - 1);
      }
    };

    // Spawn `concurrency` runners that drain the shared queue
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const brick = queue.shift();
          if (brick === undefined) break;
          await processBrick(brick);
        }
      }),
    );

    // Retry any bricks that failed (ch0 network error)
    const failed = bricks.filter(
      (b) => !this.loadedBricks.has(b.key) && !this.emptyBricks.has(b.key),
    );
    if (failed.length > 0) {
      console.warn(
        `[Kiln] loadBaseLod: ${failed.length} bricks failed, retrying sequentially`,
      );
      for (const brick of failed) {
        await processBrick(brick);
      }
    }

    // Any base bricks that still failed after retry must not leave cells at w=0
    // (unloaded → shader treats as invalid → permanent black hole). Mark them as
    // empty so the shader cleanly skips them instead of rendering a broken hole.
    const stillFailed = bricks.filter(
      (b) => !this.loadedBricks.has(b.key) && !this.emptyBricks.has(b.key),
    );
    if (stillFailed.length > 0) {
      console.error(
        `[Kiln] loadBaseLod: ${stillFailed.length} bricks permanently failed — marking empty to prevent holes`,
      );
      for (const { bx, by, bz, key } of stillFailed) {
        this.emptyBricks.add(key);
        this.resources.indirection.setEmpty(bx, by, bz, maxLod);
      }
    }

    const totalMs = performance.now() - t0;
    const firstBrickMsValue = firstBrickMs as number | null;
    const firstBrickStr =
      firstBrickMsValue !== null ? firstBrickMsValue.toFixed(0) : "n/a";
    this.baseLodPending = 0;
    this.baseLodLoaded = true;
    this.timeToFirstRender = firstBrickMsValue ?? totalMs;

    // guarantee the completed base LOD is displayed even if the camera
    // never moves again (the debounced per-brick resets may have already
    // fired before the last bricks arrived). Direct call, not debounced.
    this.onResetAccumulation();

    console.log(
      `[Kiln] loadBaseLod done: ${brickCount}/${bricks.length} bricks loaded in ${totalMs.toFixed(0)}ms` +
        ` | first brick: ${firstBrickStr}ms` +
        ` | avg isEmpty: ${(sumIsEmptyMs / bricks.length).toFixed(1)}ms` +
        ` | avg fetch: ${brickCount > 0 ? (sumFetchMs / brickCount).toFixed(1) : "n/a"}ms` +
        ` | avg upload: ${brickCount > 0 ? (sumUploadMs / brickCount).toFixed(1) : "n/a"}ms`,
    );

    // Finalize derived ranges and push to renderer + workers
    const derivedRanges: {
      dataRange?: [number, number];
      channelRanges?: Array<{ min: number; max: number }>;
    } = {};

    if (
      needsFloatRange &&
      isFinite(floatRangeMin) &&
      isFinite(floatRangeMax) &&
      floatRangeMin < floatRangeMax
    ) {
      // Percentile-clip (p0.1 / p99.9) using the in-memory base bricks —
      // absolute per-brick extremes let one hot voxel compress the whole
      // contrast range. (Falls back to raw extremes if no brick data.)
      const clipped =
        allBrickData.length > 0
          ? this.computeFloatPercentileRange(
              allBrickData as Uint16Array[],
              floatRangeMin,
              floatRangeMax,
            )
          : ([floatRangeMin, floatRangeMax] as [number, number]);
      derivedRanges.dataRange = clipped;
      this.metadata.dataRange = clipped;
      // Update workers so future brick stats use the real range
      this.dataProvider.setFloatRange?.(clipped[0], clipped[1]);
      console.log(
        `[Kiln] derived float range: [${clipped[0]}, ${clipped[1]}] (raw extremes: [${floatRangeMin}, ${floatRangeMax}])`,
      );
    }

    if (needsChannelRanges && channelMins.some((v) => isFinite(v))) {
      // Window space must match shader expectations: float windows use
      // raw-space dataRange, integer windows use effective atlas bit depth.
      const effectiveBitDepth = this.resources.canvases[0]!.bitDepth;
      const dtypeMax = effectiveBitDepth === 16 ? 65535 : 255;
      const winMin = isFloat ? (this.metadata.dataRange?.[0] ?? 0) : 0;
      const winMax = isFloat ? (this.metadata.dataRange?.[1] ?? 1) : dtypeMax;
      const ranges: Array<{ min: number; max: number }> = [];
      for (let ch = 0; ch < numChannels; ch++) {
        const cMin = isFinite(channelMins[ch]!) ? channelMins[ch]! : 0;
        const cMax = isFinite(channelMaxs[ch]!)
          ? channelMaxs[ch]!
          : isFinite(channelMins[ch]!)
            ? channelMins[ch]! + 1
            : 1;
        ranges.push({ min: cMin, max: cMax });
      }
      derivedRanges.channelRanges = ranges;
      this.metadata.channelWindows = ranges.map((r) => ({
        start: r.min,
        end: r.max,
        min: winMin,
        max: winMax,
      }));
      console.log(
        "[Kiln] derived per-channel ranges:",
        ranges.map((r, i) => `ch${i}: [${r.min}, ${r.max}]`).join(", "),
      );
    }

    if (
      (derivedRanges.dataRange || derivedRanges.channelRanges) &&
      this.onRangesDerived
    ) {
      this.onRangesDerived(derivedRanges);
    }

    if (allBrickData.length > 0 && this.onBaseLodLoaded) {
      this.onBaseLodLoaded(allBrickData);
    }
  }

  /**
   * Main update loop - call every frame
   * Returns true if any work was done
   */
  update(camera: Camera, canvas: HTMLCanvasElement): void {
    this.frameCount++;

    if (camera.version !== this.lastCameraVersion) {
      this.lastCameraVersion = camera.version;
      this.cameraStillFrames = 0;
    } else {
      this.cameraStillFrames++;
    }

    // Throttled to every updateInterval frames, both while moving and while
    // still — dispatch is gated during interaction anyway (see below), and
    // cancellation has its own grace period, so per-frame recompute during
    // movement bought nothing but full octree traversals at the tightest
    // frame budget. Recompute immediately the instant the camera stops.
    const regularUpdate =
      this.frameCount - this.lastUpdateFrame >= this.updateInterval;
    const cameraJustStopped =
      this.cameraStillFrames === this.cameraStillThreshold;

    // Don't start streaming finer LODs until base LOD is fully loaded.
    // loadBaseLod runs independently; fine bricks requested before it finishes
    // have no parent in loadedBricks, so eviction calls clearBrick without a
    // fallback and permanently holes the indirection table.
    if (!this.baseLodLoaded) {
      return;
    }

    if (
      (regularUpdate || cameraJustStopped) &&
      !this.isSettled(camera, canvas)
    ) {
      this.forceUpdate(camera, canvas);
    }

    // Gate new dispatches during interaction — keep recomputing the desired
    // set (so cancellation stays fresh) but don't start new loads that will
    // likely be stale in 100ms. Stream full detail when the camera settles.
    this.dispatchGated = camera.isInteracting();
    this.processLoadQueue();
  }

  /** Whether the view is unchanged since a recompute that left nothing to load. */
  private isSettled(camera: Camera, canvas: HTMLCanvasElement): boolean {
    const v = this.view;
    v[0] = camera.version;
    v[1] = canvas.width;
    v[2] = canvas.height;
    v[3] = this.pixelRatio;
    v[4] = this.maxPixelError;
    v[5] = this.forcedLod ?? -1;
    for (let a = 0; a < 3; a++) {
      v[6 + a] = this.clipBox ? Number(this.clipBox.min[a]) : 0;
      v[9 + a] = this.clipBox ? Number(this.clipBox.max[a]) : 1;
    }
    for (let i = 0; i < v.length; i++) {
      if (v[i] !== this.settledView[i]) return false;
    }
    return true;
  }

  /**
   * Force immediate recomputation of desired set
   */
  forceUpdate(camera: Camera, canvas: HTMLCanvasElement): void {
    this.lastUpdateFrame = this.frameCount;
    this.computeDesiredSet(camera, canvas);
    if (!this.isLoading && !this.allocationStalled) {
      this.isSettled(camera, canvas); // fills this.view
      this.settledView.set(this.view);
    } else {
      this.settledView.fill(Number.NaN);
    }
  }

  /**
   * Clear all state
   */
  clear(): void {
    // Cancel all in-flight requests
    for (const controller of this.inFlightRequests.values()) {
      controller.abort();
    }
    this.inFlightRequests.clear();
    this.inFlightStaleTime.clear();
    this.dispatchTimestamps.clear();

    // reset the allocator wholesale instead of freeing slot-by-slot.
    // The old per-slot free loop left every pinned base-LOD slot in the
    // allocator's pinned set; after reload those indices were permanently
    // unevictable. reset() clears used, pinned, metadata, and the free list.
    this.resources.allocator.reset();
    this.loadedBricks.clear();
    this.pinnedBricks.clear();
    this.emptyBricks.clear();
    this.brickCache.clear();
    this.desiredKeys.clear();
    this.loadQueue = [];
    this.allocationStalled = false;
    this.settledView.fill(Number.NaN);
    this.baseLodPending = 0;
    this.baseLodLoaded = false;
    for (const w of this.channelJobWaiters) {
      w.reject(new DOMException("Cleared", "AbortError"));
    }
    this.channelJobWaiters = [];
    this.activeChannelJobs = 0;
    this.resources.indirection.clearAll();

    // Reload base LOD
    this.loadBaseLod();
  }

  /**
   * Finest LOD currently in the desired set (falls back to resident bricks,
   * then maxLod). Used to seed a manual LOD slider at the live stream level.
   */
  getFinestStreamLod(): number {
    let finest = this.finestDesiredLod;
    if (!Number.isFinite(finest)) {
      for (const info of this.loadedBricks.values())
        finest = Math.min(finest, info.lod);
    }
    return Number.isFinite(finest) ? finest : this.metadata.maxLod;
  }

  /** Bricks are queued or in flight (the view is still refining). */
  get isLoading(): boolean {
    return (
      this.loadQueue.length > 0 ||
      this.inFlightRequests.size > 0 ||
      this.baseLodPending > 0
    );
  }

  /**
   * The view wants more bricks than the atlas can hold: the rest stay queued
   * (shown at coarser parents) and nothing is loading. Waiting won't help.
   */
  get isStalled(): boolean {
    return this.allocationStalled && this.inFlightRequests.size === 0;
  }

  getStats(): StreamingStats {
    const networkStats = this.dataProvider.getNetworkStats();
    const providerTimings = this.dataProvider.getPipelineTimings?.() ?? {
      avgQueueMs: 0,
      avgFetchMs: 0,
      avgAssemblyMs: 0,
      sampleCount: 0,
    };
    return {
      desiredCount: this.desiredCount,
      loadedCount: this.loadedCount,
      pendingCount:
        this.loadQueue.length +
        this.inFlightRequests.size +
        this.baseLodPending,
      atlasUsage: this.resources.allocator.usedCount,
      atlasCapacity: this.resources.allocator.totalSlots,
      evictedCount: this.evictedCount,
      totalBytesDownloaded: networkStats.totalBytesDownloaded,
      bytesPerSecond: networkStats.recentBytesPerSecond,
      requestCount: networkStats.requestCount,
      timeToFirstRender: this.timeToFirstRender,
      pipelineTimings: {
        avgQueueMs: providerTimings.avgQueueMs,
        avgFetchMs: providerTimings.avgFetchMs,
        avgAssemblyMs: providerTimings.avgAssemblyMs,
        avgUploadMs: this.uploadAvg.value,
        sampleCount: Math.max(
          providerTimings.sampleCount,
          this.uploadAvg.count,
        ),
        chunkCacheHitRatio: providerTimings.chunkCacheHitRatio,
      },
      bricksDispatched: this.bricksDispatched,
      bricksCommitted: this.bricksCommitted,
      bricksCancelled: this.bricksCancelled,
      bricksDiscarded: this.bricksDiscarded,
      avgBrickLatencyMs: this.brickLatencyAvg.value,
    };
  }

  /**
   * Compute the desired set of bricks based on camera position and frustum
   * Uses Screen-Space Error (SSE) for LOD selection
   */
  private computeDesiredSet(camera: Camera, canvas: HTMLCanvasElement): void {
    const cameraPos: [number, number, number] = [
      camera.position[0]!,
      camera.position[1]!,
      camera.position[2]!,
    ];

    // a fresh desired set is the retry point for refused allocations.
    this.allocationStalled = false;

    // Get frustum planes
    const aspect = canvas.width / canvas.height;
    const viewMatrix = camera.getViewMatrix();
    const projMatrix = camera.getProjectionMatrix(aspect);
    const viewProj = mat4.multiply(projMatrix, viewMatrix);
    const frustum = extractFrustumPlanes(viewProj);
    const { lo: clipLo, hi: clipHi } = clipToWorld(
      this.config.normalizedSize,
      this.clipBox?.min ?? [-Infinity, -Infinity, -Infinity],
      this.clipBox?.max ?? [Infinity, Infinity, Infinity],
    );

    // Projected size in CSS pixels (see pixelRatio). LOD selection pre-loads
    // fine bricks during interaction; dispatch gating prevents wasted loads.
    this.projectionFactor =
      canvas.height /
      Math.max(1e-3, this.pixelRatio) /
      (2 * Math.tan(this.cameraFovRad / 2));
    // View direction (−z of the view matrix): bricks near the centre of the
    // screen load first.
    const forward: [number, number, number] = [
      -(viewMatrix[2] as number),
      -(viewMatrix[6] as number),
      -(viewMatrix[10] as number),
    ];

    // Get LOD range from metadata
    const maxLod = this.maxLod;

    // Desired bricks from traversal
    const desiredBricks: BrickRequest[] = [];

    // Recursive traversal function
    const traverse = (
      bx: number,
      by: number,
      bz: number,
      lod: number,
    ): void => {
      const level = this.levelsByLod[lod];
      if (!level) return;

      const [gridX, gridY, gridZ] = level.brickGrid;

      // Bounds check - handles non-power-of-two grids
      if (
        bx < 0 ||
        bx >= gridX ||
        by < 0 ||
        by >= gridY ||
        bz < 0 ||
        bz >= gridZ
      )
        return;

      // Get brick AABB
      const aabb = this.getBrickAABB(bx, by, bz, lod);

      // Frustum and clip-box culling
      if (!isAABBInFrustum(aabb.min, aabb.max, frustum)) {
        return;
      }
      for (let a = 0; a < 3; a++) {
        if (
          (aabb.max[a] as number) <= (clipLo[a] as number) ||
          (aabb.min[a] as number) >= (clipHi[a] as number)
        ) {
          return;
        }
      }

      // Distance check
      const center = this.getAABBCenter(aabb);
      const dist = this.distance(cameraPos, center);
      // 1 on the view axis, up to 3 at the screen edges / behind
      const cosToAxis =
        dist > 1e-6
          ? ((center[0] - cameraPos[0]) * forward[0] +
              (center[1] - cameraPos[1]) * forward[1] +
              (center[2] - cameraPos[2]) * forward[2]) /
            dist
          : 1;
      const priority = dist * (1 + 2 * (1 - cosToAxis));

      // Calculate Screen-Space Error (SSE)
      // At this LOD, each voxel represents 2^lod original voxels
      // The error is the projected size of one voxel at this LOD
      const voxelWorldSize = this.getVoxelWorldSize(lod);
      const projectedError =
        (voxelWorldSize / Math.max(dist, 0.001)) * this.projectionFactor;

      // Manual override: always split while coarser than forcedLod; never
      // split at or finer than it. Otherwise use SSE + hysteresis.
      let shouldSplit: boolean;
      if (this.forcedLod !== null) {
        shouldSplit = lod > this.forcedLod;
      } else if (projectedError > this.maxPixelError) {
        shouldSplit = lod > 0;
      } else if (lod > 0 && projectedError > this.maxPixelError * 0.7) {
        // In hysteresis band — only keep splitting if children are already resident
        shouldSplit = this.hasResidentChildren(bx, by, bz, lod);
      } else {
        shouldSplit = false;
      }

      if (shouldSplit) {
        // Check if finer LOD exists
        const finerLevel = this.levelsByLod[lod - 1];
        if (!finerLevel) {
          // No finer LOD available, use current
          this.addDesiredBrick(desiredBricks, bx, by, bz, lod, priority);
          return;
        }

        // Compute child coordinates for non-power-of-two grids
        // The relationship is: parent brick covers a 2x2x2 region at finer LOD
        // But we need to check bounds at the finer level
        const [finerGridX, finerGridY, finerGridZ] = finerLevel.brickGrid;
        const nextLod = lod - 1;

        for (let dz = 0; dz < 2; dz++) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const cx = bx * 2 + dx;
              const cy = by * 2 + dy;
              const cz = bz * 2 + dz;

              // Only traverse if within finer grid bounds
              if (cx < finerGridX && cy < finerGridY && cz < finerGridZ) {
                traverse(cx, cy, cz, nextLod);
              }
            }
          }
        }
      } else {
        this.addDesiredBrick(desiredBricks, bx, by, bz, lod, priority);
      }
    };

    // Start from coarsest LOD
    const rootLevel = this.levelsByLod[maxLod];
    if (rootLevel) {
      const [gridX, gridY, gridZ] = rootLevel.brickGrid;
      for (let bz = 0; bz < gridZ; bz++) {
        for (let by = 0; by < gridY; by++) {
          for (let bx = 0; bx < gridX; bx++) {
            traverse(bx, by, bz, maxLod);
          }
        }
      }
    }

    this.addCoarseFallbacks(desiredBricks);

    const residentBricks = selectResidentSet(
      desiredBricks,
      this.pinnedBricks,
      this.resources.allocator.totalSlots,
    );

    // Update desired keys set (used for stale check)
    this.desiredKeys.clear();
    let finest = Infinity;
    for (const brick of residentBricks) {
      this.desiredKeys.add(brick.key);
      if (brick.lod < finest) finest = brick.lod;
    }
    this.finestDesiredLod = finest;

    // Cancel in-flight requests no longer desired, with a grace period
    // to avoid fetch thrash from LOD oscillation near the SSE threshold.
    const now = performance.now();
    for (const [key, controller] of this.inFlightRequests.entries()) {
      if (this.desiredKeys.has(key)) {
        // Still desired — clear any stale timestamp
        this.inFlightStaleTime.delete(key);
      } else {
        const staleTime = this.inFlightStaleTime.get(key);
        if (staleTime === undefined) {
          // First frame this request left the desired set — start grace period
          this.inFlightStaleTime.set(key, now);
        } else if (now - staleTime > this.CANCEL_GRACE_MS) {
          // Grace period expired — this request is genuinely stale, abort it
          controller.abort();
          this.inFlightRequests.delete(key);
          this.inFlightStaleTime.delete(key);
          this.bricksCancelled++;
        }
      }
    }

    // Touch all desired bricks that are already loaded
    let loadedCount = 0;
    for (const brick of residentBricks) {
      const entry = this.loadedBricks.get(brick.key);
      if (entry) {
        this.resources.allocator.touch(entry.slotIndex, this.frameCount);
        loadedCount++;
      }
    }

    // Always touch pinned bricks to keep them at the front of LRU
    for (const key of this.pinnedBricks) {
      const entry = this.loadedBricks.get(key);
      if (entry) {
        this.resources.allocator.touch(entry.slotIndex, this.frameCount);
      }
    }

    // Missing bricks, most urgent first (the resident set is priority-sorted
    // after the pinned base bricks), capped to prevent runaway loading.
    this.loadQueue = residentBricks
      .filter(
        (b) =>
          !this.loadedBricks.has(b.key) && !this.inFlightRequests.has(b.key),
      )
      .slice(0, this.maxDesiredBricks);
    this.desiredCount = residentBricks.length;
    this.loadedCount = loadedCount;
  }

  /**
   * Coarse-to-fine: a missing brick whose nearest resident ancestor is more
   * than two levels coarser also wants the ancestor two levels up, loaded
   * first (priority −1) and kept until its descendants arrive. A zoomed-in
   * view then sharpens in a few seconds from ≤16 bricks instead of waiting
   * on hundreds of full-resolution bricks over the 64³ base level.
   */
  private addCoarseFallbacks(bricks: BrickRequest[]): void {
    const seen = this.coarseFallbackKeys;
    seen.clear();
    const fallbacks: BrickRequest[] = [];
    for (const b of bricks) {
      const target = b.lod + 2;
      if (target >= this.maxLod || this.loadedBricks.has(b.key)) continue;
      // Something finer than the fallback already covers it. (A resident
      // fallback stays desired, so it isn't evicted before its descendants.)
      const parent = this.findParentBrick(b.bx, b.by, b.bz, b.lod);
      if (parent && parent.lod < target) continue;
      const s = 1 << 2;
      const ax = Math.floor(b.bx / s);
      const ay = Math.floor(b.by / s);
      const az = Math.floor(b.bz / s);
      const key = `lod${target}:${az}/${ay}/${ax}`;
      if (seen.has(key) || this.emptyBricks.has(key)) continue;
      seen.add(key);
      fallbacks.push({
        lod: target,
        bx: ax,
        by: ay,
        bz: az,
        distance: -1,
        key,
      });
    }
    for (const f of fallbacks) bricks.push(f);
  }

  /** Add a brick to the desired set unless it is known empty. */
  private addDesiredBrick(
    bricks: BrickRequest[],
    bx: number,
    by: number,
    bz: number,
    lod: number,
    priority: number,
  ): void {
    const key = `lod${lod}:${bz}/${by}/${bx}`;
    if (!this.emptyBricks.has(key))
      bricks.push({ lod, bx, by, bz, distance: priority, key });
  }

  /**
   * Process pending load requests (non-blocking)
   */
  private processLoadQueue(): void {
    // No new loads while the camera is being dragged (they'd be stale), or
    // after an allocation was refused since the last desired-set recompute —
    // don't burn network/worker time on bricks that can't get a slot.
    // computeDesiredSet clears the stall flag (retry point).
    if (this.dispatchGated || this.allocationStalled) return;

    // Start new requests up to max concurrent
    while (
      this.inFlightRequests.size < this.maxConcurrentRequests &&
      this.loadQueue.length > 0
    ) {
      // pre-dispatch check: if the atlas is full and nothing is
      // evictable, stop dispatching *before* paying the fetch cost.
      if (
        !this.resources.allocator.hasEvictableSlot(
          this.frameCount,
          this.desiredKeys.size > 0 ? this.desiredKeys : undefined,
        )
      ) {
        this.allocationStalled = true;
        break;
      }

      const request = this.loadQueue.shift()!;

      // Skip if already loaded (race condition check)
      if (this.loadedBricks.has(request.key)) continue;

      // Skip if already in flight
      if (this.inFlightRequests.has(request.key)) continue;

      // Skip if no longer desired
      if (!this.desiredKeys.has(request.key)) continue;

      // Create AbortController for this request
      const controller = new AbortController();
      this.inFlightRequests.set(request.key, controller);
      this.dispatchTimestamps.set(request.key, performance.now());
      this.bricksDispatched++;

      this.loadBrick(request, controller.signal).finally(() => {
        // Guard against a stale .finally() from an aborted request deleting a newer
        // controller that was registered for the same key in the same sync block.
        if (this.inFlightRequests.get(request.key) === controller) {
          this.inFlightRequests.delete(request.key);
        }
        this.dispatchTimestamps.delete(request.key);
        // Refill the freed slot now rather than on the next update tick.
        this.processLoadQueue();
      });
    }
  }

  /**
   * Load a single brick with abort support
   */
  private async loadBrick(
    request: BrickRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const { lod, bx, by, bz, key } = request;

    // Check if aborted before starting
    if (signal.aborted) return;

    // Check if empty
    const isEmpty = await this.dataProvider.isBrickEmpty(
      lod,
      bx,
      by,
      bz,
      this.config.emptyBrickThreshold,
    );
    if (signal.aborted) return;

    if (isEmpty) {
      this.emptyBricks.add(key);
      this.resources.indirection.setEmpty(bx, by, bz, lod);
      // This may overwrite a coarse parent fallback that was already on screen —
      // the region needs to redraw as empty rather than staying on the stale frame.
      this.scheduleAccumulationReset();
      return;
    }

    // Try CPU cache first, fall back to network — load all channels in parallel.
    // Capped to renderer.numChannels (≤ MAX_CHANNELS) so we never write to a non-existent atlas.
    // Caching deferred until after emptiness check (empty bricks shouldn't evict useful cache entries).
    const numChannels = this.resources.numChannels;
    const fromCache: boolean[] = new Array(numChannels).fill(false);
    const channelResults: (BrickLoadResult | null)[] = await Promise.all(
      Array.from({ length: numChannels }, async (_, ch) => {
        if (!this.channelEnabled[ch]) return null;
        const cacheKey = `ch${ch}:${key}`;
        const cached = this.brickCache.get(cacheKey);
        if (cached) {
          fromCache[ch] = true;
          // Cached data has no stats — use 1 for max so it's never treated as empty
          return { data: cached, min: 0, max: 1, avg: 0 } as BrickLoadResult;
        }
        try {
          return await this.withChannelJob(
            () =>
              this.dataProvider.loadBrick(
                lod,
                bx,
                by,
                bz,
                ch,
                signal,
                request.distance,
              ),
            signal,
            request.distance,
          );
        } catch (err) {
          if (
            signal.aborted ||
            (err instanceof DOMException && err.name === "AbortError")
          ) {
            return null;
          }
          throw err;
        }
      }),
    );
    if (signal.aborted) return;

    // At least one enabled channel must succeed; hidden channels are skipped.
    let haveVisibleData = false;
    for (let ch = 0; ch < numChannels; ch++) {
      if (this.channelEnabled[ch] && channelResults[ch]) {
        haveVisibleData = true;
        break;
      }
    }
    if (!haveVisibleData) return;

    // Emptiness check via inline stats. Skipped for cache-served bricks
    // (sentinel stats would false-positive; cached bricks are already proven non-empty).
    if (!fromCache.some((v) => v)) {
      const threshold = this.config.emptyBrickThreshold ?? 1;
      let maxAcrossChannels = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        if (!this.channelEnabled[ch]) continue;
        const m = channelResults[ch]?.max ?? 0;
        if (m > maxAcrossChannels) maxAcrossChannels = m;
      }
      if (maxAcrossChannels < threshold) {
        this.emptyBricks.add(key);
        this.resources.indirection.setEmpty(bx, by, bz, lod);
        // Same as above: may overwrite a coarse parent fallback already on screen.
        this.scheduleAccumulationReset();
        return;
      }
    }

    // brick is known non-empty — now it's worth caching. (Done before the
    // desired-set check: a brick fetched but no longer desired is still likely
    // to be desired again soon.) Channels reported stale meanwhile aren't
    // cached; they are reloaded once committed.
    const stale = this.staleOnArrival.get(signal);
    for (let ch = 0; ch < numChannels; ch++) {
      const r = channelResults[ch];
      if (r && !fromCache[ch] && !stale?.has(ch)) {
        this.brickCache.put(`ch${ch}:${key}`, r.data);
      }
    }

    // Camera may have moved while the fetch was in flight — skip if no longer desired
    if (!this.desiredKeys.has(key)) {
      this.bricksDiscarded++;
      return;
    }

    // Allocate one slot (shared atlas position across all channels)
    const result = this.resources.allocator.allocate(
      this.frameCount,
      this.desiredKeys.size > 0 ? this.desiredKeys : undefined,
    );
    if (!result) {
      // silent backpressure — the brick stays desired and retries after
      // the next computeDesiredSet; the shader keeps rendering the coarser
      // parent via indirection, so a refusal costs nothing visually.
      this.allocationStalled = true;

      return;
    }

    // Handle eviction
    if (result.evicted) {
      this.evictedCount++;
      const evictedKey = result.evicted.key;
      const evictedEntry = this.loadedBricks.get(evictedKey);

      if (!evictedEntry || evictedEntry.slotIndex === result.slotIndex) {
        const fallback = this.findParentBrick(
          result.evicted.bx,
          result.evicted.by,
          result.evicted.bz,
          result.evicted.lod,
        );

        if (fallback) {
          this.resources.indirection.clearBrick(
            result.evicted.bx,
            result.evicted.by,
            result.evicted.bz,
            result.evicted.lod,
            [fallback.slot.x, fallback.slot.y, fallback.slot.z],
            fallback.lod,
          );
        } else if (
          this.hasEmptyAncestor(
            result.evicted.bx,
            result.evicted.by,
            result.evicted.bz,
            result.evicted.lod,
          )
        ) {
          // Ancestor is known-empty — restore empty marker (w=255) so the
          // shader skips this region instead of treating w=0 as unloaded.
          this.resources.indirection.setEmpty(
            result.evicted.bx,
            result.evicted.by,
            result.evicted.bz,
            result.evicted.lod,
          );
        } else {
          // No parent found - clear completely (shouldn't happen if base LOD is loaded)
          this.resources.indirection.clearBrick(
            result.evicted.bx,
            result.evicted.by,
            result.evicted.bz,
            result.evicted.lod,
          );
        }
        this.loadedBricks.delete(evictedKey);
      }
    }

    // Upload enabled channels (and zero-fill failed enabled ones — recycled
    // atlas slots may still hold a previous brick). Hidden channels are only
    // marked empty; backfillChannel writes them if re-enabled.
    const tUpload = performance.now();
    for (let ch = 0; ch < numChannels; ch++) {
      if (this.channelEnabled[ch])
        this.resources.writeBrick(
          result.slot,
          ch,
          channelResults[ch]?.data ?? null,
        );
      else this.resources.clearChannel(result.slot, ch);
    }
    this.uploadAvg.add(performance.now() - tUpload);

    // Update indirection
    this.resources.indirection.setBrick(
      bx,
      by,
      bz,
      result.slot.x,
      result.slot.y,
      result.slot.z,
      lod,
    );

    // Set metadata for future eviction
    this.resources.allocator.setMetadata(result.slotIndex, {
      lod,
      bx,
      by,
      bz,
      key,
    });

    // Track
    const info: LoadedBrickInfo = {
      slot: result.slot,
      slotIndex: result.slotIndex,
      lod,
      bx,
      by,
      bz,
    };
    this.loadedBricks.set(key, info);
    this.bricksCommitted++;
    if (stale)
      for (const ch of stale) void this.reloadBrickChannel(ch, key, info);

    // Record end-to-end latency (dispatch → committed)
    const dispatchTime = this.dispatchTimestamps.get(key);
    if (dispatchTime !== undefined) {
      this.brickLatencyAvg.add(performance.now() - dispatchTime);
    }

    // Schedule accumulation reset to prevent constant flickering during streaming bursts
    this.scheduleAccumulationReset();
  }

  /**
   * Show newly committed bricks, at most every RESET_COALESCE_MS. A debounce
   * restarted by every commit either never fired during a steady stream or
   * fired on almost every brick, each time restarting a full accumulation.
   */
  private scheduleAccumulationReset(): void {
    if (this.resetAccumulationTimer !== null) return;
    this.resetAccumulationTimer = setTimeout(() => {
      this.resetAccumulationTimer = null;
      if (perfOn && this.perfBackfills > 0 && !this.isLoading) {
        perfCount("restarts from a backfill, rendered as final (not loading)");
      }
      this.onResetAccumulation();
    }, RESET_COALESCE_MS) as unknown as number;
  }

  // Helper functions

  private getBrickAABB(
    bx: number,
    by: number,
    bz: number,
    lod: number,
  ): { min: [number, number, number]; max: [number, number, number] } {
    const level = this.levelsByLod[lod];
    if (!level) return { min: [0, 0, 0], max: [0, 0, 0] };

    const normalizedSize = this.config.normalizedSize;
    const [gridX, gridY, gridZ] = level.brickGrid;
    const brickSize: [number, number, number] = [
      normalizedSize[0] / gridX,
      normalizedSize[1] / gridY,
      normalizedSize[2] / gridZ,
    ];

    const min: [number, number, number] = [
      -normalizedSize[0] * 0.5 + bx * brickSize[0],
      -normalizedSize[1] * 0.5 + by * brickSize[1],
      -normalizedSize[2] * 0.5 + bz * brickSize[2],
    ];
    const max: [number, number, number] = [
      min[0] + brickSize[0],
      min[1] + brickSize[1],
      min[2] + brickSize[2],
    ];

    return { min, max };
  }

  private getAABBCenter(aabb: {
    min: [number, number, number];
    max: [number, number, number];
  }): [number, number, number] {
    return [
      (aabb.min[0] + aabb.max[0]) * 0.5,
      (aabb.min[1] + aabb.max[1]) * 0.5,
      (aabb.min[2] + aabb.max[2]) * 0.5,
    ];
  }

  private distance(
    a: [number, number, number],
    b: [number, number, number],
  ): number {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Get the world-space size of one voxel at a given LOD level
   * At LOD N, each voxel represents 2^N original voxels
   */
  private getVoxelWorldSize(lod: number): number {
    const normalizedSize = this.config.normalizedSize;
    const dims = this.metadata.dimensions;

    // Base voxel size in normalized space (LOD 0)
    // Use the largest dimension for consistent error metric
    const maxDim = Math.max(dims[0], dims[1], dims[2]);
    const baseVoxelSize =
      Math.max(normalizedSize[0], normalizedSize[1], normalizedSize[2]) /
      maxDim;

    // At LOD N, each voxel represents 2^N original voxels
    return baseVoxelSize * (1 << lod);
  }

  /**
   * Find the parent (coarser LOD) brick that covers the same region
   * Used to restore fallback data when evicting a finer LOD brick
   */
  private findParentBrick(
    bx: number,
    by: number,
    bz: number,
    lod: number,
  ): { slot: AtlasSlot; lod: number } | null {
    const maxLod = this.maxLod;

    // Walk up the LOD hierarchy to find a loaded parent
    for (let parentLod = lod + 1; parentLod <= maxLod; parentLod++) {
      // Parent coordinates are halved for each LOD level up
      const scale = 1 << (parentLod - lod);
      const parentBx = Math.floor(bx / scale);
      const parentBy = Math.floor(by / scale);
      const parentBz = Math.floor(bz / scale);

      const parentKey = `lod${parentLod}:${parentBz}/${parentBy}/${parentBx}`;
      const parentEntry = this.loadedBricks.get(parentKey);

      if (parentEntry) {
        return { slot: parentEntry.slot, lod: parentLod };
      }
    }

    return null;
  }

  /**
   * SSE hysteresis: keep a split only while every child (one LOD finer) is
   * loaded, in flight or known empty. "Any child" kept all 8 siblings
   * requested once one of them had loaded.
   */
  private hasResidentChildren(
    bx: number,
    by: number,
    bz: number,
    lod: number,
  ): boolean {
    const finerLod = lod - 1;
    const finer = this.levelsByLod[finerLod];
    if (!finer) return false;
    const [gx, gy, gz] = finer.brickGrid;
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cx = bx * 2 + dx;
          const cy = by * 2 + dy;
          const cz = bz * 2 + dz;
          if (cx >= gx || cy >= gy || cz >= gz) continue;
          const childKey = `lod${finerLod}:${cz}/${cy}/${cx}`;
          if (
            !this.loadedBricks.has(childKey) &&
            !this.inFlightRequests.has(childKey) &&
            !this.emptyBricks.has(childKey)
          ) {
            return false;
          }
        }
      }
    }
    return true;
  }

  /** Check if any ancestor brick is known-empty (for eviction fallback). */
  private hasEmptyAncestor(
    bx: number,
    by: number,
    bz: number,
    lod: number,
  ): boolean {
    const maxLod = this.maxLod;
    for (let parentLod = lod + 1; parentLod <= maxLod; parentLod++) {
      const scale = 1 << (parentLod - lod);
      const parentKey = `lod${parentLod}:${Math.floor(bz / scale)}/${Math.floor(by / scale)}/${Math.floor(bx / scale)}`;
      if (this.emptyBricks.has(parentKey)) return true;
    }
    return false;
  }
}
