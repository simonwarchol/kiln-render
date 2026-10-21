/**
 * Pure planning helpers for Imaris bricks.
 *
 * Kiln's renderer assumes an isotropic pyramid: LOD L is exactly 2^L coarser
 * than LOD 0 on every axis. Imaris pyramids are not (Z is only halved once it
 * is long enough), so the provider exposes a *virtual* isotropic pyramid and
 * box-resamples each brick from the coarsest Imaris level that is still at
 * least as fine as the virtual level on every axis.
 *
 * Axis order here is always [x, y, z]; HDF5 datasets are stored [z, y, x].
 */

import {
  LOGICAL_BRICK_SIZE as LOGICAL,
  PHYSICAL_BRICK_SIZE as PHYSICAL,
} from "../../core/config.js";

export { LOGICAL, PHYSICAL };

/** Decoded (float16) chunk cache per brick worker. */
export const WORKER_CHUNK_BUDGET = 96 * 1024 * 1024;

export type Vec3 = [number, number, number];

export interface SourceLevel {
  /** Imaris ResolutionLevel index */
  index: number;
  /** ImageSizeX/Y/Z (valid voxels; datasets may be padded beyond this) */
  dims: Vec3;
}

export interface VirtualLevel {
  lod: number;
  dims: Vec3;
  brickGrid: Vec3;
  /** Imaris level sampled for this LOD */
  source: number;
  /** Source voxels per virtual voxel along each axis (≥ 1) */
  ratio: Vec3;
}

/**
 * Build the virtual pyramid: dims_L = ceil(dims0 / 2^L) until the whole
 * volume fits in one brick, each mapped to the best Imaris source level.
 */
export function planVirtualPyramid(sources: SourceLevel[]): VirtualLevel[] {
  if (sources.length === 0) return [];
  const base = sources[0]!.dims;
  const out: VirtualLevel[] = [];
  for (let lod = 0; lod < 16; lod++) {
    const f = 2 ** lod;
    const dims: Vec3 = [
      Math.max(1, Math.ceil(base[0] / f)),
      Math.max(1, Math.ceil(base[1] / f)),
      Math.max(1, Math.ceil(base[2] / f)),
    ];
    // Coarsest source whose downsampling factor ≤ 2^L on every axis.
    let best = sources[0]!;
    for (const s of sources) {
      const ok = [0, 1, 2].every(
        (a) => base[a]! / Math.max(1, s.dims[a]!) <= f * 1.001,
      );
      if (
        ok &&
        s.dims[0] * s.dims[1] * s.dims[2] <
          best.dims[0] * best.dims[1] * best.dims[2]
      ) {
        best = s;
      }
    }
    const ratio: Vec3 = [
      best.dims[0] / dims[0],
      best.dims[1] / dims[1],
      best.dims[2] / dims[2],
    ];
    out.push({
      lod,
      dims,
      brickGrid: [
        Math.ceil(dims[0] / LOGICAL),
        Math.ceil(dims[1] / LOGICAL),
        Math.ceil(dims[2] / LOGICAL),
      ],
      source: best.index,
      ratio,
    });
    if (dims[0] <= LOGICAL && dims[1] <= LOGICAL && dims[2] <= LOGICAL) break;
  }
  return out;
}

/**
 * For each output voxel along one axis of a brick (PHYSICAL samples incl.
 * the 1-voxel ghost border, edge-clamped), the [start, end) range of source
 * voxels it averages. Returns flat [start0, end0, start1, end1, …] plus the
 * overall source span.
 */
export function axisSampling(
  brick: number,
  virtualDim: number,
  sourceDim: number,
  ratio: number,
): { ranges: Int32Array; lo: number; hi: number } {
  const ranges = new Int32Array(PHYSICAL * 2);
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (let i = 0; i < PHYSICAL; i++) {
    const v = Math.min(virtualDim - 1, Math.max(0, brick * LOGICAL - 1 + i));
    let s0 = Math.floor(v * ratio + 1e-6);
    let s1 = Math.ceil((v + 1) * ratio - 1e-6);
    s0 = Math.min(sourceDim - 1, Math.max(0, s0));
    s1 = Math.min(sourceDim, Math.max(s0 + 1, s1));
    ranges[i * 2] = s0;
    ranges[i * 2 + 1] = s1;
    lo = Math.min(lo, s0);
    hi = Math.max(hi, s1);
  }
  return { ranges, lo, hi };
}

/** Chunk grid coordinates (x, y, z) overlapping a source box [lo, hi). */
export function overlappingChunks(lo: Vec3, hi: Vec3, chunk: Vec3): Vec3[] {
  const out: Vec3[] = [];
  const c0 = [0, 1, 2].map((a) => Math.floor(lo[a]! / chunk[a]!));
  const c1 = [0, 1, 2].map((a) => Math.floor((hi[a]! - 1) / chunk[a]!));
  for (let cz = c0[2]!; cz <= c1[2]!; cz++)
    for (let cy = c0[1]!; cy <= c1[1]!; cy++)
      for (let cx = c0[0]!; cx <= c1[0]!; cx++) out.push([cx, cy, cz]);
  return out;
}

/** Group byte ranges into coalesced reads (sorted by address). */
export function coalesceRanges(
  refs: Array<{ address: number; size: number }>,
  maxGap = 64 * 1024,
  maxBytes = 16 * 1024 * 1024,
): Array<{ start: number; end: number; members: number[] }> {
  const order = refs
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => a.address - b.address);
  const out: Array<{ start: number; end: number; members: number[] }> = [];
  for (const r of order) {
    const last = out[out.length - 1];
    const end = r.address + r.size;
    if (
      last &&
      r.address - last.end <= maxGap &&
      Math.max(last.end, end) - last.start <= maxBytes
    ) {
      last.end = Math.max(last.end, end);
      last.members.push(r.i);
    } else {
      out.push({ start: r.address, end, members: [r.i] });
    }
  }
  return out;
}
