/**
 * ZarrDataProvider - Loads OME-Zarr (NGFF) datasets over HTTP via a Web Worker pool.
 * Zarr [z,y,x] metadata is swapped to Kiln's [x,y,z]; memory layout is unchanged.
 */

import type { DataType, Readable } from "zarrita";
import { open, root, type Array as ZarrArray } from "zarrita";
import { BaseZarrProvider, detectCompression } from "./base-zarr-provider.js";
import type {
  BrickLoadResult,
  ProviderTimings,
  VolumeMetadata,
} from "./data-provider.js";
import { UnsupportedDatasetError } from "./data-provider.js";
import { TolerantFetchStore } from "./tolerant-fetch-store.js";
import { openMultiscales } from "./zarr-validator.js";
import { ZarrWorkerPool } from "./zarr-worker-pool.js";

/**
 * DataProvider implementation for OME-Zarr (NGFF v0.5) volumes over HTTP
 */
export class ZarrDataProvider extends BaseZarrProvider {
  private url: string;

  /** Worker pool for off-main-thread brick loading */
  private workerPool: ZarrWorkerPool | null = null;
  private targetFormat?: "r8unorm" | "r16unorm" | "r16float";

  constructor(url: string) {
    super();
    this.url = url.replace(/\/$/, "");
  }

  /**
   * Set target texture format for worker output
   * Format determines output format: r8unorm (8-bit), r16unorm (16-bit uint), r16float (16-bit float)
   */
  async setTargetFormat(
    format: "r8unorm" | "r16unorm" | "r16float",
  ): Promise<void> {
    this.targetFormat = format;
    if (this.workerPool) {
      await this.workerPool.setTargetFormat(format);
    }
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    // Use zarrita on main thread for lightweight metadata reading only
    const store = new TolerantFetchStore(this.url);
    const rootGroup = await open(root(store), { kind: "group" });

    // OME multiscales on the root, or bioformats2raw's sub-group "0"
    const found = await openMultiscales(rootGroup);
    if (!found) {
      throw new UnsupportedDatasetError([
        "No OME-NGFF multiscales metadata found",
      ]);
    }
    const { group, attrs, ms, prefix } = found;
    const arrayPaths = ms.datasets.map((ds) => `${prefix}${ds.path}`);

    // Open arrays on main thread to read metadata (shape, chunks, dtype)
    const arrays: ZarrArray<DataType, Readable>[] = await Promise.all(
      ms.datasets.map((ds) => open(group.resolve(ds.path), { kind: "array" })),
    );

    // Parse metadata using base class helper
    const urlParts = this.url.split("/");
    const name =
      urlParts[urlParts.length - 1]?.replace(/\.ome\.zarr|\.zarr/, "") ??
      "zarr-volume";
    const { metadata, lodParams } = this.parseOmeMetadata(attrs, arrays, name);

    // Provisional dataRange for float data without OMERO window — real range
    // is derived incrementally during base LOD loading.
    if (metadata.isFloat && !metadata.dataRange) {
      metadata.dataRange = [0, 1];
    }

    metadata.compression = await detectCompression(store, arrayPaths[0] ?? "");

    // Backfill the metadata reads made above (group/array opens, compression
    // probe) — small, but real network activity that should count too.
    this.recordDownload(store.bytesFetched, store.requestCount);

    this.metadata = metadata;

    // Initialize worker pool — all heavy lifting happens there. Workers get
    // the metadata documents read above instead of fetching them again.
    this.workerPool = new ZarrWorkerPool();
    await this.workerPool.init(
      this.url,
      arrayPaths,
      lodParams,
      metadata.brickSize,
      metadata.physicalBrickSize,
      metadata.bitDepth === 16,
      this.targetFormat,
      metadata.isFloat ?? false,
      metadata.dataRange,
      store.metadata,
    );

    return this.metadata;
  }

  /** Load a fully assembled 66³ brick via the worker pool (fully off main thread). */
  async loadBrick(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    channelIndex = 0,
    signal?: AbortSignal,
  ): Promise<BrickLoadResult | null> {
    const meta = this.getMetadata();
    const level = meta.levels.find((l) => l.lod === lod);
    if (!level) return null;

    if (
      bx < 0 ||
      bx >= level.brickGrid[0] ||
      by < 0 ||
      by >= level.brickGrid[1] ||
      bz < 0 ||
      bz >= level.brickGrid[2]
    ) {
      return null;
    }

    try {
      const result = await this.workerPool!.loadBrick(
        lod,
        bx,
        by,
        bz,
        channelIndex,
        signal,
      );

      // Cache stats for isBrickEmpty checks
      this.cacheBrickStats(lod, bx, by, bz, channelIndex, {
        min: result.min,
        max: result.max,
        avg: result.avg,
      });

      // Real network bytes/requests for this brick's chunks, reported by the
      // worker's store. Falls back to the assembled-buffer size only if a
      // worker didn't report it (shouldn't happen once initialized).
      this.recordDownload(
        result.chunkBytesFetched ?? result.data.byteLength,
        result.chunkRequestsIssued ?? 1,
      );

      return result;
    } catch (e) {
      // Aborted requests are expected — return null silently
      if (e instanceof DOMException && e.name === "AbortError") return null;
      console.warn(`Failed to load brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  /**
   * Update the float normalisation range on all workers.
   * Called after base LOD loading derives the actual data range.
   */
  async setFloatRange(min: number, max: number): Promise<void> {
    if (this.workerPool) {
      await this.workerPool.setFloatRange(min, max);
    }
  }

  getPipelineTimings(): ProviderTimings {
    return (
      this.workerPool?.getPipelineTimings() ?? {
        avgQueueMs: 0,
        avgFetchMs: 0,
        avgAssemblyMs: 0,
        sampleCount: 0,
      }
    );
  }

  dispose(): void {
    this.brickStatsCache.clear();
    this.workerPool?.terminate();
    this.workerPool = null;
  }
}
