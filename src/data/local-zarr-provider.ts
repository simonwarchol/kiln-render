/**
 * LocalZarrDataProvider - Loads OME-Zarr from local filesystem via
 * File System Access API. Runs on main thread (handles can't transfer to workers).
 */

import type { DataType } from "zarrita";
import { open, root, type Array as ZarrArray } from "zarrita";
import { ByteLru } from "../utils/byte-lru.js";
import { BaseZarrProvider, detectCompression } from "./base-zarr-provider.js";
import type {
  BrickLoadResult,
  ProviderTimings,
  VolumeMetadata,
} from "./data-provider.js";
import { UnsupportedDatasetError } from "./data-provider.js";
import { FileSystemStore } from "./filesystem-store.js";
import { RollingAvg } from "./network-tracker.js";
import {
  assembleBrick,
  chunkCoords,
  type DecodedChunk,
  type LodParams,
  planBrick,
} from "./zarr-brick.js";
import { openMultiscales } from "./zarr-validator.js";

/** Decoded chunks kept for neighbouring bricks (each chunk feeds several). */
const CHUNK_CACHE_BYTES = 128 * 1024 * 1024;

export class LocalZarrDataProvider extends BaseZarrProvider {
  private dirHandle: FileSystemDirectoryHandle;
  private arrays: ZarrArray<DataType, any>[] = [];
  private lodParams: LodParams[] = [];
  private targetFormat: "r8unorm" | "r16float" = "r16float";
  private readonly chunks = new ByteLru<string, DecodedChunk>(
    CHUNK_CACHE_BYTES,
    (c) => (ArrayBuffer.isView(c.data) ? c.data.byteLength : c.data.length * 2),
  );
  private readonly decoding = new Map<string, Promise<DecodedChunk>>();

  // Per-stage rolling averages (last 32 bricks)
  private fetchAvg = new RollingAvg();
  private assemblyAvg = new RollingAvg();

  constructor(dirHandle: FileSystemDirectoryHandle) {
    super();
    this.dirHandle = dirHandle;
  }

  // r16float: convert uint16 → float16 bit pattern. r8unorm: downsample to 8-bit.
  setTargetFormat(format: "r8unorm" | "r16float"): void {
    this.targetFormat = format;
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    const store = new FileSystemStore(this.dirHandle);
    const rootGroup = await open(root(store), { kind: "group" });

    // OME multiscales on the root, or bioformats2raw's sub-group "0"
    const found = await openMultiscales(rootGroup);
    if (!found) {
      throw new UnsupportedDatasetError([
        "No OME-NGFF multiscales metadata found",
      ]);
    }
    const { group, attrs, ms, prefix } = found;

    this.arrays = await Promise.all(
      ms.datasets.map((ds) => open(group.resolve(ds.path), { kind: "array" })),
    );

    // Parse metadata using base class helper
    const name = this.dirHandle.name.replace(/\.ome\.zarr|\.zarr/, "");
    const { metadata, lodParams } = this.parseOmeMetadata(
      attrs,
      this.arrays,
      name,
    );

    // Provisional dataRange — real range derived during base LOD loading
    if (metadata.isFloat && !metadata.dataRange) {
      metadata.dataRange = [0, 1];
    }

    metadata.compression = await detectCompression(
      store,
      `${prefix}${ms.datasets[0]!.path}`,
    );

    this.metadata = metadata;
    this.lodParams = lodParams;

    return this.metadata;
  }

  async loadBrick(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    channelIndex = 0,
  ): Promise<BrickLoadResult | null> {
    const meta = this.metadata;
    if (!meta) return null;

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
      const result = await this.assemble(meta, lod, bx, by, bz, channelIndex);
      const { min, max, avg } = result;
      this.cacheBrickStats(lod, bx, by, bz, { min, max, avg });
      this.recordDownload(result.data.byteLength);
      return result;
    } catch (e) {
      console.warn(`Failed to load brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  getPipelineTimings(): ProviderTimings {
    return {
      avgQueueMs: 0, // no worker queue in local provider
      avgFetchMs: this.fetchAvg.value,
      avgAssemblyMs: this.assemblyAvg.value,
      sampleCount: this.fetchAvg.count,
    };
  }

  /** A decoded chunk, from the cache or shared with a read in flight. */
  private chunk(
    lod: number,
    channelIndex: number,
    cz: number,
    cy: number,
    cx: number,
  ): Promise<DecodedChunk> {
    const key = `${lod}:${channelIndex}:${cz}/${cy}/${cx}`;
    const hit = this.chunks.get(key);
    if (hit) return Promise.resolve(hit);
    let p = this.decoding.get(key);
    if (!p) {
      const coords = chunkCoords(
        this.lodParams[lod]!,
        channelIndex,
        cz,
        cy,
        cx,
      );
      const arrays = this.arrays;
      p = arrays[lod]!.getChunk(coords)
        .then((c) => {
          const chunk = {
            data: c.data as unknown as ArrayLike<number>,
            shape: c.shape,
          };
          if (this.arrays === arrays) this.chunks.set(key, chunk);
          return chunk;
        })
        .finally(() => this.decoding.delete(key));
      this.decoding.set(key, p);
    }
    return p;
  }

  private async assemble(
    meta: VolumeMetadata,
    lod: number,
    bx: number,
    by: number,
    bz: number,
    channelIndex: number,
  ): Promise<BrickLoadResult> {
    const plan = planBrick(
      this.lodParams[lod]!,
      bx,
      by,
      bz,
      meta.brickSize,
      meta.physicalBrickSize,
    );

    // --- Stage 1: chunk read (filesystem I/O + zarr decompression) ---
    const t0 = performance.now();
    const reads: Promise<DecodedChunk>[] = [];
    for (let cz = plan.minCz; cz <= plan.maxCz; cz++)
      for (let cy = plan.minCy; cy <= plan.maxCy; cy++)
        for (let cx = plan.minCx; cx <= plan.maxCx; cx++)
          reads.push(this.chunk(lod, channelIndex, cz, cy, cx));
    const chunks = await Promise.all(reads);
    this.fetchAvg.add(performance.now() - t0);

    // --- Stage 2: brick assembly ---
    const t1 = performance.now();
    const is16bit = meta.bitDepth === 16;
    const isFloat = meta.isFloat ?? false;
    const downsampleTo8 =
      is16bit && !isFloat && this.targetFormat === "r8unorm";
    const brick = assembleBrick(plan, chunks, {
      isFloat,
      floatMin: meta.dataRange?.[0] ?? 0,
      floatMax: meta.dataRange?.[1] ?? 1,
      out: is16bit && !downsampleTo8 ? "u16" : "u8",
      // Stats stay in source units, also when storing the high byte.
      encode: downsampleTo8 ? "high-byte" : is16bit ? "f16" : "raw",
    });
    this.assemblyAvg.add(performance.now() - t1);
    return brick;
  }

  dispose(): void {
    this.brickStatsCache.clear();
    this.chunks.clear();
    this.decoding.clear();
    this.arrays = [];
  }
}
