/**
 * ImarisDataProvider — streams Imaris 5.5 (.ims) HDF5 over HTTP Range or a local File.
 */

import { LOGICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE } from "../core/config.js";
import type {
  BrickLoadResult,
  BrickStats,
  DataProvider,
  NetworkStats,
  PipelineTimings,
  VolumeMetadata,
} from "./data-provider.js";
import { UnsupportedDatasetError } from "./data-provider.js";
import { ImarisWorkerPool } from "./imaris-worker-pool.js";
import { NetworkTracker } from "./network-tracker.js";

const MAX_STATS_ENTRIES = 100_000;

export class ImarisDataProvider implements DataProvider {
  private readonly tracker = new NetworkTracker();
  private workerPool: ImarisWorkerPool | null = null;
  private metadata: VolumeMetadata | null = null;
  private readonly brickStatsCache = new Map<string, BrickStats>();
  private targetFormat: "r8unorm" | "r16unorm" | "r16float" = "r16float";

  constructor(private readonly source: string | File) {}

  async setTargetFormat(
    format: "r8unorm" | "r16unorm" | "r16float",
  ): Promise<void> {
    this.targetFormat = format;
    await this.workerPool?.setTargetFormat(format);
  }

  async setFloatRange(min: number, max: number): Promise<void> {
    if (this.metadata) this.metadata.dataRange = [min, max];
    await this.workerPool?.setFloatRange(min, max);
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    this.workerPool = new ImarisWorkerPool();
    const info = await this.workerPool.init(this.source);
    if (info.reasons.length > 0) {
      this.workerPool.terminate();
      this.workerPool = null;
      throw new UnsupportedDatasetError(info.reasons);
    }

    if (this.targetFormat !== "r16float") {
      await this.workerPool.setTargetFormat(this.targetFormat);
    }

    this.metadata = {
      name: info.name,
      dimensions: info.dimensions,
      voxelSpacing: info.voxelSpacing,
      brickSize: LOGICAL_BRICK_SIZE,
      physicalBrickSize: PHYSICAL_BRICK_SIZE,
      maxLod: Math.max(0, info.levels.length - 1),
      levels: info.levels,
      bitDepth: info.bitDepth,
      numChannels: info.numChannels,
      isFloat: info.isFloat,
      dataRange: info.isFloat ? [0, 1] : undefined,
      compression: info.compression,
    };
    return this.metadata;
  }

  getMetadata(): VolumeMetadata {
    if (!this.metadata) {
      throw new Error("Metadata not loaded. Call initialize() first.");
    }
    return this.metadata;
  }

  getBrickGrid(lod: number): [number, number, number] {
    const level = this.getMetadata().levels.find((l) => l.lod === lod);
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
  ): Promise<BrickLoadResult | null> {
    const level = this.metadata?.levels.find((l) => l.lod === lod);
    if (!this.metadata || !level || !this.workerPool) return null;
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
      const result = await this.workerPool.loadBrick(
        lod,
        bx,
        by,
        bz,
        channelIndex,
        signal,
      );
      this.cacheBrickStats(lod, bx, by, bz, {
        min: result.min,
        max: result.max,
        avg: result.avg,
      });
      this.tracker.record(
        result.chunkBytesFetched ?? result.data.byteLength,
        result.chunkRequestsIssued ?? 1,
      );
      return result;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return null;
      console.warn(`Failed to load brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  async isBrickEmpty(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    maxThreshold?: number,
  ): Promise<boolean> {
    const stats = await this.getBrickStats(lod, bx, by, bz);
    return !!stats && stats.max < (maxThreshold ?? 1);
  }

  async getBrickStats(
    lod: number,
    bx: number,
    by: number,
    bz: number,
  ): Promise<BrickStats | null> {
    return this.brickStatsCache.get(`${lod}:${bx}/${by}/${bz}`) ?? null;
  }

  getNetworkStats(): NetworkStats {
    return this.tracker.getStats();
  }

  getPipelineTimings(): PipelineTimings {
    return (
      this.workerPool?.getPipelineTimings() ?? {
        avgQueueMs: 0,
        avgFetchMs: 0,
        avgAssemblyMs: 0,
        avgUploadMs: 0,
        sampleCount: 0,
      }
    );
  }

  dispose(): void {
    this.brickStatsCache.clear();
    this.workerPool?.terminate();
    this.workerPool = null;
    this.metadata = null;
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
            avg: (existing.avg + stats.avg) / 2,
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
