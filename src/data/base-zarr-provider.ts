/**
 * BaseZarrProvider - Shared base for OME-Zarr metadata parsing, LOD calculation,
 * and brick stats. Subclassed by ZarrDataProvider (HTTP) and LocalZarrDataProvider (FS).
 */

import type { DataType, Array as ZarrArray } from "zarrita";
import { LOGICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE } from "../core/config.js";
import type {
  BitDepth,
  BrickLoadResult,
  BrickStats,
  DataProvider,
  LodLevel,
  NetworkStats,
  VolumeMetadata,
} from "./data-provider.js";

import { UnsupportedDatasetError } from "./data-provider.js";
import { NetworkTracker } from "./network-tracker.js";
import type { LodParams } from "./zarr-brick.js";
import {
  extractMultiscales,
  normalizeAxes,
  type OmeMultiscales,
  packedChannelsReason,
  validateZarrSupport,
} from "./zarr-validator.js";

export type { LodParams } from "./zarr-brick.js";

/** Detect the compression codec from zarr v2 (.zarray) or v3 (zarr.json) metadata. */
export async function detectCompression(
  store: { get: (key: any) => Promise<Uint8Array | undefined> },
  arrayPath: string,
): Promise<string | undefined> {
  const tryParse = async (key: string): Promise<any> => {
    const bytes = await store.get(key).catch(() => undefined);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  };

  // Zarr v2: .zarray has a "compressor" field
  const v2 = await tryParse(`/${arrayPath}/.zarray`);
  if (v2) {
    const c = v2.compressor;
    if (!c) return undefined;
    return c.id === "blosc" ? `blosc/${c.cname ?? "lz4"}` : String(c.id);
  }

  // Zarr v3: zarr.json has a "codecs" array
  const v3 = await tryParse(`/${arrayPath}/zarr.json`);
  if (v3?.codecs) {
    const comp = (v3.codecs as { name: string }[]).find((c) =>
      ["blosc", "zstd", "gzip", "zlib", "bz2", "lz4"].includes(c.name),
    );
    return comp?.name;
  }

  return undefined;
}

/**
 * Abstract base class for Zarr providers
 */
export abstract class BaseZarrProvider implements DataProvider {
  // Bounds long panning sessions on multi-gigabyte datasets — otherwise one
  // entry accumulates per brick ever touched, cleared only on dispose().
  private static readonly MAX_STATS_ENTRIES = 100_000;

  protected metadata: VolumeMetadata | null = null;
  /** Per brick, the stats of each channel slot loaded for it. */
  protected brickStatsCache = new Map<string, Array<BrickStats | undefined>>();
  private networkTracker = new NetworkTracker();

  // Abstract methods that subclasses must implement
  abstract initialize(): Promise<VolumeMetadata>;
  abstract loadBrick(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    channelIndex?: number,
    signal?: AbortSignal,
  ): Promise<BrickLoadResult | null>;
  abstract dispose(): void;

  /**
   * Get cached metadata
   */
  getMetadata(): VolumeMetadata {
    if (!this.metadata) {
      throw new Error("Metadata not loaded. Call initialize() first.");
    }
    return this.metadata;
  }

  /**
   * Get brick grid dimensions for a LOD level
   */
  getBrickGrid(lod: number): [number, number, number] {
    const meta = this.getMetadata();
    const level = meta.levels.find((l) => l.lod === lod);
    if (!level) {
      throw new Error(`LOD level ${lod} not found`);
    }
    return level.brickGrid;
  }

  /**
   * Check if a brick is empty (max value below threshold) in each of
   * `channels` (default: the channels loaded for it so far)
   */
  async isBrickEmpty(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    maxThreshold?: number,
    channels?: readonly number[],
  ): Promise<boolean> {
    const key = `${lod}:${bx}/${by}/${bz}`;
    const perChannel = this.brickStatsCache.get(key);
    if (!perChannel) return false;
    // Move to end (most recently used) — Maps preserve insertion order.
    this.brickStatsCache.delete(key);
    this.brickStatsCache.set(key, perChannel);
    const slots =
      channels ?? perChannel.flatMap((s, slot) => (s ? [slot] : []));
    // A channel not loaded for the brick may have data there.
    return (
      slots.length > 0 &&
      slots.every((slot) => {
        const stats = perChannel[slot];
        return stats !== undefined && stats.max < (maxThreshold ?? 1);
      })
    );
  }

  /**
   * Get network/IO statistics
   */
  getNetworkStats(): NetworkStats {
    return this.networkTracker.getStats();
  }

  /**
   * Record download/read for statistics tracking
   */
  protected recordDownload(bytes: number, requests = 1): void {
    this.networkTracker.record(bytes, requests);
  }

  /**
   * Cache brick statistics
   */
  protected cacheBrickStats(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    channel: number,
    stats: BrickStats,
  ): void {
    const key = `${lod}:${bx}/${by}/${bz}`;
    // Kept per channel: isBrickEmpty asks about the channels shown.
    const perChannel = this.brickStatsCache.get(key) ?? [];
    perChannel[channel] = stats;
    this.brickStatsCache.delete(key);
    this.brickStatsCache.set(key, perChannel);

    // Evict oldest (least recently used/inserted) entries once over the cap.
    while (this.brickStatsCache.size > BaseZarrProvider.MAX_STATS_ENTRIES) {
      const oldest = this.brickStatsCache.keys().next().value!;
      this.brickStatsCache.delete(oldest);
    }
  }

  /**
   * Parse OME-Zarr metadata and build VolumeMetadata.
   * @internal — takes zarrita `Array` types; not part of the public API surface.
   *   Stripped from emitted .d.ts (stripInternal) so `zarrita` doesn't leak into
   *   published types (consumers don't install it — it's bundled).
   */
  protected parseOmeMetadata(
    attrs: Record<string, unknown>,
    arrays: ZarrArray<DataType, any>[],
    name: string,
  ): { metadata: VolumeMetadata; lodParams: LodParams[] } {
    // Parse OME multiscales from group attributes
    const omeAttr = attrs["ome"] as
      | {
          multiscales?: OmeMultiscales[];
          omero?: {
            channels?: {
              window?: { start: number; end: number; min: number; max: number };
            }[];
          };
        }
      | undefined;

    const ms = extractMultiscales(attrs);
    if (!ms) {
      throw new UnsupportedDatasetError([
        "No OME-NGFF multiscales metadata found",
      ]);
    }

    const numScales = ms.datasets.length;

    // Parse axes — supports both v0.4 string arrays and v0.5 typed objects
    const axisNames = normalizeAxes(ms.axes);
    const channelAxisIdx = axisNames.findIndex((a) => a.type === "channel");
    const numChannels =
      channelAxisIdx >= 0
        ? Math.max(1, arrays[0]!.shape[channelAxisIdx] ?? 1)
        : 1;

    // Safety-net validation (catches direct ?dataset= URL loads that bypassed dialog pre-check)
    const dtype = arrays[0]!.dtype;
    const validationReasons = validateZarrSupport(
      ms,
      arrays[0]!.shape,
      String(dtype),
      arrays[0]!.chunks,
    );
    for (const a of arrays.slice(1)) {
      const packed = packedChannelsReason(channelAxisIdx, a.shape, a.chunks);
      if (packed && !validationReasons.includes(packed))
        validationReasons.push(packed);
    }
    if (validationReasons.length > 0)
      throw new UnsupportedDatasetError(validationReasons);

    // Determine bit depth from dtype
    const dtypeStr = String(dtype);
    let bitDepth: BitDepth;
    let isFloat = false;
    if (dtypeStr === "uint8" || dtypeStr === "int8") {
      bitDepth = 8;
    } else if (dtypeStr === "uint16" || dtypeStr === "int16") {
      bitDepth = 16;
    } else if (dtypeStr === "float32" || dtypeStr === "float64") {
      // Float data is normalised to [0, 65535] in the worker → 16-bit pipeline
      bitDepth = 16;
      isFloat = true;
    } else {
      bitDepth = 8; // unreachable after validation, satisfies type checker
    }

    // Compute voxel spacing from coordinateTransformations if available.
    // v0.5: per-dataset transforms; v0.4: may be at group level instead.
    let voxelSpacing: [number, number, number] | undefined;
    const transforms =
      ms.datasets[0]?.coordinateTransformations ?? ms.coordinateTransformations;
    if (transforms) {
      const scaleTransform = transforms.find((t) => t.type === "scale");
      if (scaleTransform?.scale) {
        const s = scaleTransform.scale;
        // Zarr stores as [z, y, x], convert to [x, y, z]
        voxelSpacing = [s[s.length - 1]!, s[s.length - 2]!, s[s.length - 3]!];
      }
    }

    // Build LOD levels with virtual dimensions for uniform 2:1 downsampling
    const lod0Shape = arrays[0]!.shape; // [z, y, x]
    const lod0Dims: [number, number, number] = [
      lod0Shape[lod0Shape.length - 1]!, // x
      lod0Shape[lod0Shape.length - 2]!, // y
      lod0Shape[lod0Shape.length - 3]!, // z
    ];

    const lodParams: LodParams[] = [];
    const levels: LodLevel[] = arrays.map((arr, i) => {
      const shape = arr.shape;
      const actualDimX = shape[shape.length - 1]!;
      const actualDimY = shape[shape.length - 2]!;
      const actualDimZ = shape[shape.length - 3]!;

      const virtualDimX = Math.ceil(lod0Dims[0] / (1 << i));
      const virtualDimY = Math.ceil(lod0Dims[1] / (1 << i));
      const virtualDimZ = Math.ceil(lod0Dims[2] / (1 << i));

      const chunkShape = arr.chunks;
      const shapePrefixLength = shape.length - 3;
      lodParams.push({
        scaleX: actualDimX / virtualDimX,
        scaleY: actualDimY / virtualDimY,
        scaleZ: actualDimZ / virtualDimZ,
        actualDimX,
        actualDimY,
        actualDimZ,
        csx: chunkShape[chunkShape.length - 1]!,
        csy: chunkShape[chunkShape.length - 2]!,
        csz: chunkShape[chunkShape.length - 3]!,
        shapePrefixLength,
        channelAxisIdx,
      });

      const brickGrid: [number, number, number] = [
        Math.ceil(virtualDimX / LOGICAL_BRICK_SIZE),
        Math.ceil(virtualDimY / LOGICAL_BRICK_SIZE),
        Math.ceil(virtualDimZ / LOGICAL_BRICK_SIZE),
      ];

      return {
        lod: i,
        dimensions: [virtualDimX, virtualDimY, virtualDimZ] as [
          number,
          number,
          number,
        ],
        brickGrid,
        brickCount: brickGrid[0] * brickGrid[1] * brickGrid[2],
      };
    });

    // Extract OMERO window metadata if available (per-channel and backward-compat single)
    type WindowEntry = { start: number; end: number; min: number; max: number };
    let windowMeta: WindowEntry | undefined;
    let channelWindows: Array<WindowEntry | undefined> | undefined;
    const omeroAttr = omeAttr?.omero;
    if (Array.isArray(omeroAttr?.channels) && omeroAttr.channels.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channelWindows = omeroAttr.channels.map(
        (ch: any) => ch?.window as WindowEntry | undefined,
      );
      windowMeta = channelWindows[0];
    }

    // For float data, derive initial dataRange from OMERO window (absolute min/max).
    // If no OMERO window is present, the caller must scan the coarsest LOD to fill this in.
    let dataRange: [number, number] | undefined;
    if (isFloat && windowMeta) {
      dataRange = [windowMeta.min, windowMeta.max];
    }

    const metadata: VolumeMetadata = {
      name,
      dimensions: levels[0]!.dimensions,
      voxelSpacing,
      brickSize: LOGICAL_BRICK_SIZE,
      physicalBrickSize: PHYSICAL_BRICK_SIZE,
      maxLod: numScales - 1,
      levels,
      bitDepth,
      window: windowMeta,
      channelWindows,
      numChannels,
      isFloat,
      dataRange,
    };

    // Each brick reads every chunk its footprint overlaps: small chunks make
    // that many requests per brick.
    const p0 = lodParams[0]!;
    const span = (dim: number, cs: number, scale: number) =>
      Math.max(
        1,
        Math.min(
          Math.ceil(dim / cs),
          Math.floor(((PHYSICAL_BRICK_SIZE - 1) * scale) / cs) + 1,
        ),
      );
    const fanout =
      span(p0.actualDimX, p0.csx, p0.scaleX) *
      span(p0.actualDimY, p0.csy, p0.scaleY) *
      span(p0.actualDimZ, p0.csz, p0.scaleZ) *
      numChannels;
    if (fanout > 16) {
      console.warn(
        `[Kiln] Up to ${fanout} chunk reads per full-resolution brick (chunks ${p0.csx}×${p0.csy}×${p0.csz}` +
          `${numChannels > 1 ? `, ${numChannels} channels` : ""}); chunks of ≥64 per axis (or Zarr v3 sharding) load faster.`,
      );
    }

    return { metadata, lodParams };
  }
}
