/**
 * ShardedDataProvider - Loads volume data from Kiln's native sharded format
 * (volume.json + lodN.bin + lodN_index.json) using HTTP Range requests.
 */

import type {
  BrickData,
  BrickLoadResult,
  DataProvider,
  LodLevel,
  NetworkStats,
  ProviderTimings,
  VolumeMetadata,
} from "./data-provider.js";
import { DecompressionPool } from "./decompression-pool.js";
import { NetworkTracker, RollingAvg } from "./network-tracker.js";
import { type BrickConversion, convertBrick } from "./sharded-brick.js";

/** Format-specific metadata from volume.json */
interface ShardedVolumeJson {
  name: string;
  originalDimensions: [number, number, number];
  voxelSpacing: [number, number, number];
  brickSize: number;
  physicalSize: number;
  maxLod: number;
  levels: {
    lod: number;
    dimensions: [number, number, number];
    bricks: [number, number, number];
    brickCount: number;
    binFile: string;
    indexFile: string;
  }[];
  format: "uint8" | "uint16";
  packed: true;
  compressed?: boolean;
  createdAt: string;
}

/** Format-specific LOD index structure */
interface ShardedLodIndex {
  lod: number;
  brickSize: number;
  physicalSize: number;
  bricks: [number, number, number];
  totalBricks: number;
  totalBytes: number;
  compressed?: boolean;
  entries: Record<string, ShardedBrickEntry>;
}

/** Entry in the LOD index */
interface ShardedBrickEntry {
  offset: number;
  size: number;
  min: number;
  max: number;
  avg: number;
}

/**
 * DataProvider implementation for Kiln's sharded binary format
 */
export class ShardedDataProvider implements DataProvider {
  private basePath: string;
  private rawMetadata: ShardedVolumeJson | null = null;
  private metadata: VolumeMetadata | null = null;
  private lodIndices = new Map<number, Promise<ShardedLodIndex>>();
  private networkTracker = new NetworkTracker();
  /** gzip workers, created for the first compressed brick */
  private pool: DecompressionPool | null = null;
  private targetFormat: "r8unorm" | "r16unorm" | "r16float" = "r16unorm";
  private fetchAvg = new RollingAvg();
  private assemblyAvg = new RollingAvg();

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Set the atlas texture format bricks are converted to.
   * Must be called before the first brick load.
   */
  setTargetFormat(format: "r8unorm" | "r16unorm" | "r16float"): void {
    this.targetFormat = format;
  }

  /** How stored bricks become atlas texels. */
  private conversion(): BrickConversion {
    if (this.rawMetadata?.format !== "uint16") return "none";
    if (this.targetFormat === "r16float") return "u16-to-f16";
    return this.targetFormat === "r8unorm" ? "u16-to-u8" : "none";
  }

  /**
   * Initialize the provider by loading volume.json
   */
  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    const response = await fetch(`${this.basePath}/volume.json`);
    if (!response.ok) {
      throw new Error(`Failed to load volume metadata: ${response.statusText}`);
    }

    this.rawMetadata = await response.json();
    this.metadata = this.convertMetadata(this.rawMetadata!);

    return this.metadata;
  }

  /**
   * Convert format-specific metadata to generic VolumeMetadata
   */
  private convertMetadata(raw: ShardedVolumeJson): VolumeMetadata {
    const levels: LodLevel[] = raw.levels.map((level) => ({
      lod: level.lod,
      dimensions: level.dimensions,
      brickGrid: level.bricks,
      brickCount: level.brickCount,
    }));

    return {
      name: raw.name,
      dimensions: raw.originalDimensions,
      voxelSpacing: raw.voxelSpacing,
      brickSize: raw.brickSize,
      physicalBrickSize: raw.physicalSize,
      maxLod: raw.maxLod,
      levels,
      bitDepth: raw.format === "uint16" ? 16 : 8,
      numChannels: 1,
    };
  }

  /**
   * Get the loaded metadata
   */
  getMetadata(): VolumeMetadata {
    if (!this.metadata) {
      throw new Error("Metadata not loaded. Call initialize() first.");
    }
    return this.metadata;
  }

  /**
   * Get brick grid for a LOD level
   */
  getBrickGrid(lod: number): [number, number, number] {
    const meta = this.getMetadata();
    const level = meta.levels.find((l) => l.lod === lod);
    if (!level) {
      throw new Error(`LOD level ${lod} not found`);
    }
    return level.brickGrid;
  }

  /** The index for a LOD level (fetched once, shared by concurrent callers). */
  private loadLodIndex(lod: number): Promise<ShardedLodIndex> {
    let index = this.lodIndices.get(lod);
    if (!index) {
      const level = this.rawMetadata?.levels.find((l) => l.lod === lod);
      if (!level)
        return Promise.reject(new Error(`LOD level ${lod} not found`));
      index = fetch(`${this.basePath}/${level.indexFile}`).then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load LOD index: ${response.statusText}`);
        }
        return response.json() as Promise<ShardedLodIndex>;
      });
      index.catch(() => this.lodIndices.delete(lod));
      this.lodIndices.set(lod, index);
    }
    return index;
  }

  /** Empty when the index says the brick's max is below the threshold. */
  async isBrickEmpty(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    maxThreshold?: number,
  ): Promise<boolean> {
    const entry = (await this.loadLodIndex(lod)).entries[`${bx}/${by}/${bz}`];
    if (!entry) return false; // Unknown = assume non-empty
    return entry.max < (maxThreshold ?? 100);
  }

  /**
   * Load a single brick
   */
  async loadBrick(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    _channelIndex?: number,
    signal?: AbortSignal,
  ): Promise<BrickLoadResult | null> {
    if (!this.rawMetadata) {
      throw new Error("Metadata not loaded");
    }

    // Validate coordinates
    const level = this.rawMetadata.levels.find((l) => l.lod === lod);
    if (!level) return null;

    if (
      bx < 0 ||
      bx >= level.bricks[0] ||
      by < 0 ||
      by >= level.bricks[1] ||
      bz < 0 ||
      bz >= level.bricks[2]
    ) {
      return null;
    }

    try {
      const index = await this.loadLodIndex(lod);
      const brickKey = `${bx}/${by}/${bz}`;
      const entry = index.entries[brickKey];

      if (!entry) {
        return null;
      }

      const url = `${this.basePath}/${level.binFile}`;
      const rangeEnd = entry.offset + entry.size - 1;

      const tFetch = performance.now();
      const response = await fetch(url, {
        headers: {
          Range: `bytes=${entry.offset}-${rangeEnd}`,
        },
        signal,
      });

      if (!response.ok && response.status !== 206) {
        console.warn(`Failed to fetch brick ${brickKey}: ${response.status}`);
        return null;
      }

      const buffer = await response.arrayBuffer();
      this.networkTracker.record(buffer.byteLength);
      this.fetchAvg.add(performance.now() - tFetch);

      // Assembly: decompress (in a worker) + conversion to the atlas format
      const tAssembly = performance.now();
      const isCompressed =
        index.compressed ?? this.rawMetadata.compressed ?? false;
      const conversion = this.conversion();

      let out: Uint8Array | Uint16Array;
      if (isCompressed) {
        this.pool ??= new DecompressionPool();
        out = await this.pool.decompress(buffer, conversion);
      } else {
        out = convertBrick(new Uint8Array(buffer), conversion);
      }

      const sixteenBit =
        this.rawMetadata.format === "uint16" && conversion !== "u16-to-u8";
      const data: BrickData =
        sixteenBit && out instanceof Uint8Array
          ? new Uint16Array(out.buffer, out.byteOffset, out.byteLength / 2)
          : out;
      this.assemblyAvg.add(performance.now() - tAssembly);

      return { data, min: entry.min, max: entry.max, avg: entry.avg };
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return null;
      console.warn(`Error loading brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  getNetworkStats(): NetworkStats {
    return this.networkTracker.getStats();
  }

  getPipelineTimings(): ProviderTimings {
    return {
      avgQueueMs: 0, // no worker queue in sharded provider
      avgFetchMs: this.fetchAvg.value,
      avgAssemblyMs: this.assemblyAvg.value,
      sampleCount: this.fetchAvg.count,
    };
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.lodIndices.clear();
    this.pool?.terminate();
    this.pool = null;
  }
}
