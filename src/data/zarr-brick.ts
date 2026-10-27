/**
 * OME-Zarr brick planning and assembly, shared by the HTTP worker
 * (zarr-chunk-worker.ts) and the local provider (main thread). Pure: no
 * zarrita, no I/O.
 *
 * A brick is PHYSICAL³ voxels (LOGICAL + a 1-voxel ghost border) of the
 * virtual, uniformly downsampled level; each voxel takes the nearest voxel
 * of the actual Zarr array (`scale` = actual / virtual size per axis).
 */

import {
  float32ToFloat16Bits,
  getUint16ToFloat16Lut,
} from "../utils/float16.js";

/** Per-LOD scale factors and chunk parameters */
export interface LodParams {
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  actualDimX: number;
  actualDimY: number;
  actualDimZ: number;
  csx: number;
  csy: number;
  csz: number;
  /** Number of non-spatial prefix dims before [z, y, x] (e.g. 1 for [c, z, y, x]). */
  shapePrefixLength: number;
  /** Index of the channel axis within the full shape array (-1 if no channel axis). */
  channelAxisIdx: number;
}

/** First chunk index along one axis that brick `b` reads. */
export function firstChunk(
  b: number,
  scale: number,
  chunkSize: number,
  logical: number,
): number {
  return Math.floor(
    Math.floor(Math.max(0, b * logical - 1) * scale) / chunkSize,
  );
}

export interface BrickPlan {
  physical: number;
  /** Chunk coordinate box read (inclusive) */
  minCx: number;
  minCy: number;
  minCz: number;
  maxCx: number;
  maxCy: number;
  maxCz: number;
  ncx: number;
  ncy: number;
  /** Chunks in the box; flat index (cz - minCz) * ncy * ncx + (cy - minCy) * ncx + (cx - minCx) */
  count: number;
  /** Per brick coordinate: chunk index (relative to the box) and offset inside it */
  chunkX: Int32Array;
  chunkY: Int32Array;
  chunkZ: Int32Array;
  offX: Int32Array;
  offY: Int32Array;
  offZ: Int32Array;
}

export function planBrick(
  p: LodParams,
  bx: number,
  by: number,
  bz: number,
  logical: number,
  physical: number,
): BrickPlan {
  const axis = (b: number, scale: number, dim: number, cs: number) => {
    const vStart = b * logical - 1;
    const aStart = Math.floor(Math.max(0, vStart) * scale);
    const aEnd = Math.min(dim - 1, Math.floor((vStart + physical - 1) * scale));
    const minC = Math.floor(aStart / cs);
    const chunk = new Int32Array(physical);
    const off = new Int32Array(physical);
    for (let i = 0; i < physical; i++) {
      // Clamp to the fetched window, not the full volume — round() can land
      // one voxel past aEnd (computed with floor) on scaled pyramid levels.
      const g = Math.max(
        aStart,
        Math.min(aEnd, Math.round((vStart + i) * scale)),
      );
      const c = Math.floor(g / cs);
      chunk[i] = c - minC;
      off[i] = g - c * cs;
    }
    return { minC, maxC: Math.floor(aEnd / cs), chunk, off };
  };
  const x = axis(bx, p.scaleX, p.actualDimX, p.csx);
  const y = axis(by, p.scaleY, p.actualDimY, p.csy);
  const z = axis(bz, p.scaleZ, p.actualDimZ, p.csz);
  const ncx = x.maxC - x.minC + 1;
  const ncy = y.maxC - y.minC + 1;
  return {
    physical,
    minCx: x.minC,
    minCy: y.minC,
    minCz: z.minC,
    maxCx: x.maxC,
    maxCy: y.maxC,
    maxCz: z.maxC,
    ncx,
    ncy,
    count: ncx * ncy * (z.maxC - z.minC + 1),
    chunkX: x.chunk,
    chunkY: y.chunk,
    chunkZ: z.chunk,
    offX: x.off,
    offY: y.off,
    offZ: z.off,
  };
}

/** Full chunk coordinates (non-spatial prefix, then z, y, x) for zarrita's getChunk. */
export function chunkCoords(
  p: LodParams,
  channelIndex: number,
  cz: number,
  cy: number,
  cx: number,
): number[] {
  const coords = new Array<number>(p.shapePrefixLength + 3).fill(0);
  if (p.channelAxisIdx >= 0 && p.channelAxisIdx < p.shapePrefixLength) {
    coords[p.channelAxisIdx] = channelIndex;
  }
  coords[p.shapePrefixLength] = cz;
  coords[p.shapePrefixLength + 1] = cy;
  coords[p.shapePrefixLength + 2] = cx;
  return coords;
}

export interface DecodedChunk {
  data: ArrayLike<number>;
  shape: number[];
}

export interface AssembleOptions {
  /** Float source: voxels hold float16 of the raw value; stats are [floatMin, floatMax] → [0, 65535] */
  isFloat: boolean;
  floatMin: number;
  floatMax: number;
  /** Output array: 8- or 16-bit */
  out: "u8" | "u16";
  /**
   * Integer sources: store the value as read, as float16 bits of value/65535
   * (r16float atlas), or its high byte (16-bit source into an 8-bit atlas).
   * Stats are always the source values.
   */
  encode: "raw" | "f16" | "high-byte";
}

export interface AssembledBrick {
  data: Uint8Array | Uint16Array;
  min: number;
  max: number;
  avg: number;
  /** Raw-space extremes (float sources only) */
  rawMin?: number;
  rawMax?: number;
}

/**
 * Gather a brick from its decoded chunks (`chunks[i]` for the plan's flat
 * index i; null chunks leave zeros and don't count towards min/max).
 */
export function assembleBrick(
  plan: BrickPlan,
  chunks: ReadonlyArray<DecodedChunk | null>,
  opts: AssembleOptions,
): AssembledBrick {
  const P = plan.physical;
  // Flat per-chunk lookups for the voxel loop.
  const datas = new Array<ArrayLike<number> | null>(plan.count).fill(null);
  const chunkW = new Int32Array(plan.count);
  const chunkWH = new Int32Array(plan.count);
  for (let i = 0; i < plan.count; i++) {
    const c = chunks[i];
    if (!c) continue;
    datas[i] = c.data;
    chunkW[i] = c.shape[c.shape.length - 1]!;
    chunkWH[i] = chunkW[i]! * c.shape[c.shape.length - 2]!;
  }
  const brick =
    opts.out === "u16" ? new Uint16Array(P * P * P) : new Uint8Array(P * P * P);
  const { isFloat, floatMin, floatMax } = opts;
  const range = floatMax - floatMin;
  const lut =
    !isFloat && opts.encode === "f16" ? getUint16ToFloat16Lut() : null;
  const highByte = !isFloat && opts.encode === "high-byte";

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let rawMin = Number.POSITIVE_INFINITY;
  let rawMax = Number.NEGATIVE_INFINITY;

  for (let lz = 0; lz < P; lz++) {
    const zBase = plan.chunkZ[lz]! * plan.ncy * plan.ncx;
    const lcz = plan.offZ[lz]!;
    for (let ly = 0; ly < P; ly++) {
      const yzBase = zBase + plan.chunkY[ly]! * plan.ncx;
      const lcy = plan.offY[ly]!;
      const row = (lz * P + ly) * P;
      for (let lx = 0; lx < P; lx++) {
        const fi = yzBase + plan.chunkX[lx]!;
        const data = datas[fi];
        if (!data) continue;
        const raw =
          data[lcz * chunkWH[fi]! + lcy * chunkW[fi]! + plan.offX[lx]!]!;
        let stat: number;
        if (isFloat) {
          const n =
            range > 0 ? Math.max(0, Math.min(1, (raw - floatMin) / range)) : 0;
          stat = Math.round(n * 65535);
          // Raw value as float16 bits (the shader normalises with
          // floatMin/floatMax), clamped to r16float's range.
          brick[row + lx] = float32ToFloat16Bits(
            Math.max(-65504, Math.min(65504, raw)),
          );
          if (Number.isFinite(raw)) {
            if (raw < rawMin) rawMin = raw;
            if (raw > rawMax) rawMax = raw;
          }
        } else {
          stat = raw;
          brick[row + lx] = lut ? lut[raw]! : highByte ? raw >> 8 : raw;
        }
        if (stat < min) min = stat;
        if (stat > max) max = stat;
        sum += stat;
      }
    }
  }
  return {
    data: brick,
    min: min === Number.POSITIVE_INFINITY ? 0 : min,
    max: max === Number.NEGATIVE_INFINITY ? 0 : max,
    avg: sum / (P * P * P),
    rawMin: isFloat && Number.isFinite(rawMin) ? rawMin : undefined,
    rawMax: isFloat && Number.isFinite(rawMax) ? rawMax : undefined,
  };
}
