/** Kiln Configuration — volume rendering and virtual texturing constants. */

// Core constants
export const LOGICAL_BRICK_SIZE = 64;
export const PHYSICAL_BRICK_SIZE = 66; // 64 + 1 voxel padding on each side
export const ATLAS_SIZE = 660; // Grid slots * physical brick size - 528, 660, 792, etc.
export const MAX_BRICK_TRAVERSALS = 512; // Upper bound for shader loop termination
/** Hard cap on simultaneously rendered channels (uniforms + atlas bindings). */
export const MAX_CHANNELS = 6;

// Derived constants - GRID_SIZE determines how many bricks fit in the atlas
// ATLAS_SIZE = GRID_SIZE * PHYSICAL_BRICK_SIZE
// 528 = 8 * 66, 660 = 10 * 66, 792 = 12 * 66, etc.
export const GRID_SIZE = Math.floor(ATLAS_SIZE / PHYSICAL_BRICK_SIZE);

/** Leaves GPU headroom for splat generation/training next to the atlas. */
export const DEFAULT_ATLAS_BUDGET_BYTES = 2_000_000_000;

/** Software rasterizer — `computeAtlasGrid` clamps this to `MIN_GRID_SIZE`. */
export const ATLAS_BUDGET_FALLBACK_BYTES = 1;

/** iGPU / low-RAM class: middle of the 512 MiB–1 GiB band. */
export const ATLAS_BUDGET_CONSTRAINED_BYTES = 768 * 1024 * 1024;

const MIB = 1024 * 1024;
const SMALL_BUFFER_BYTES = 512 * MIB;
const LARGE_BUFFER_BYTES = 1024 * MIB;

/** Adapter signals we can read without a VRAM query. */
export interface AdapterMemoryHints {
  maxBufferSize: number;
  isFallbackAdapter?: boolean;
  /** `navigator.deviceMemory` (GiB buckets), when the browser exposes it. */
  deviceMemoryGiB?: number;
}

/**
 * Pick an atlas byte budget from device class. Leaves headroom for the
 * compositor, other tabs, TAA, and 1920 capture — not a free-VRAM estimate.
 */
export function guessAtlasBudgetBytes(hints: AdapterMemoryHints): number {
  if (hints.isFallbackAdapter) return ATLAS_BUDGET_FALLBACK_BYTES;
  const tinyRam =
    hints.deviceMemoryGiB !== undefined && hints.deviceMemoryGiB <= 4;
  if (hints.maxBufferSize <= SMALL_BUFFER_BYTES || tinyRam) {
    return ATLAS_BUDGET_CONSTRAINED_BYTES;
  }
  if (hints.maxBufferSize >= LARGE_BUFFER_BYTES) {
    return DEFAULT_ATLAS_BUDGET_BYTES;
  }
  return ATLAS_BUDGET_CONSTRAINED_BYTES;
}

export function adapterMemoryHints(
  adapter: GPUAdapter,
  deviceMemoryGiB?: number,
): AdapterMemoryHints {
  const info = adapter.info as { isFallbackAdapter?: boolean } | undefined;
  const legacy = adapter as GPUAdapter & { isFallbackAdapter?: boolean };
  return {
    maxBufferSize: adapter.limits.maxBufferSize,
    isFallbackAdapter:
      info?.isFallbackAdapter === true || legacy.isFallbackAdapter === true,
    deviceMemoryGiB,
  };
}

export function readDeviceMemoryGiB(): number | undefined {
  const memory = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory;
  return typeof memory === "number" && memory > 0 ? memory : undefined;
}

// Smallest grid computeAtlasGrid may return — must still hold the pinned base
// LOD plus a working set.
export const MIN_GRID_SIZE = 6;

/** Drop one atlas grid step; `null` when already at `MIN_GRID_SIZE`. */
export function nextSmallerAtlasGrid(gridSize: number): number | null {
  const next = gridSize - 1;
  return next >= MIN_GRID_SIZE ? next : null;
}

/**
 * Largest atlas grid (slots/axis) whose VRAM (numChannels × atlasSize³ ×
 * bytesPerVoxel) fits budgetBytes, clamped to [MIN_GRID_SIZE, GRID_SIZE].
 */
export function computeAtlasGrid(
  numChannels: number,
  bytesPerVoxel: number,
  budgetBytes: number = DEFAULT_ATLAS_BUDGET_BYTES,
): { gridSize: number; atlasSize: number } {
  const bytesPerChannel = budgetBytes / Math.max(1, numChannels);
  const voxelsPerChannel = bytesPerChannel / Math.max(1, bytesPerVoxel);
  const rawGrid = Math.floor(Math.cbrt(voxelsPerChannel) / PHYSICAL_BRICK_SIZE);
  const gridSize = Math.max(MIN_GRID_SIZE, Math.min(GRID_SIZE, rawGrid));
  return { gridSize, atlasSize: gridSize * PHYSICAL_BRICK_SIZE };
}

function computeDatasetGrid(
  dimensions: [number, number, number],
): [number, number, number] {
  return [
    Math.ceil(dimensions[0] / LOGICAL_BRICK_SIZE),
    Math.ceil(dimensions[1] / LOGICAL_BRICK_SIZE),
    Math.ceil(dimensions[2] / LOGICAL_BRICK_SIZE),
  ];
}

function computeNormalizedSize(
  dimensions: [number, number, number],
  voxelSpacing: [number, number, number],
): [number, number, number] {
  const physicalSize: [number, number, number] = [
    dimensions[0] * voxelSpacing[0],
    dimensions[1] * voxelSpacing[1],
    dimensions[2] * voxelSpacing[2],
  ];
  const maxDim = Math.max(...physicalSize);
  return [
    physicalSize[0] / maxDim,
    physicalSize[1] / maxDim,
    physicalSize[2] / maxDim,
  ];
}

/**
 * Immutable value object describing dataset geometry.
 * Computed from VolumeMetadata and injected into subsystems at construction.
 */
export class DatasetConfig {
  readonly dimensions: [number, number, number];
  readonly voxelSpacing: [number, number, number];
  /** Bricks per axis at LOD 0 */
  readonly datasetGrid: [number, number, number];
  /** Normalized extent [0–1] per axis, accounting for anisotropic voxel spacing */
  readonly normalizedSize: [number, number, number];
  /** Bricks with max intensity below this value are considered empty */
  readonly emptyBrickThreshold: number;

  constructor(
    dimensions: [number, number, number],
    voxelSpacing: [number, number, number] = [1, 1, 1],
    emptyBrickThreshold = 100,
  ) {
    this.dimensions = [...dimensions] as [number, number, number];
    this.voxelSpacing = [...voxelSpacing] as [number, number, number];
    this.emptyBrickThreshold = emptyBrickThreshold;
    this.datasetGrid = computeDatasetGrid(dimensions);
    this.normalizedSize = computeNormalizedSize(dimensions, voxelSpacing);
  }
}

/** Clip box (0–1 per axis) → world-space AABB, as the shaders clip. */
export function clipToWorld(
  normalizedSize: readonly number[],
  clipMin: ArrayLike<number>,
  clipMax: ArrayLike<number>,
): { lo: [number, number, number]; hi: [number, number, number] } {
  const at = (c: ArrayLike<number>, a: number, d: number) =>
    ((c[a] ?? d) - 0.5) * normalizedSize[a]!;
  return {
    lo: [at(clipMin, 0, 0), at(clipMin, 1, 0), at(clipMin, 2, 0)],
    hi: [at(clipMax, 0, 1), at(clipMax, 1, 1), at(clipMax, 2, 1)],
  };
}
