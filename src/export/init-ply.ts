/**
 * Voxel → 3DGS init.ply for Brush seeding / SuperSplat preview.
 * Samples the finest pyramid level whose brick count fits a fetch budget
 * (not the coarsest LOD), so the preview matches volume quality more closely.
 */

import {
  type DatasetConfig,
  LOGICAL_BRICK_SIZE,
  MAX_CHANNELS,
  PHYSICAL_BRICK_SIZE,
} from "../core/config.js";
import type { TransferFunction } from "../core/transfer-function.js";
import type { BrickData, DataProvider } from "../data/data-provider.js";
import { getFloat16ToFloat32Lut } from "../utils/float16.js";
import { type GaussianSplat, writeGaussianPly } from "./gaussian-ply.js";

/** Defaults matching Renderer.channelColors (R, G, B, C, M, Y). */
const DEFAULT_CHANNEL_COLORS = new Float32Array([
  1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1,
]);

/** Finest LOD whose full brick grid we are willing to fetch for init.ply. */
export const DEFAULT_MAX_INIT_BRICKS = 216;
/** Default Gaussian cap for the preview PLY. */
export const DEFAULT_MAX_SPLATS = 1_000_000;

export interface InitPlyOptions {
  /**
   * Pyramid level to sample (0 = finest). Default: finest level with
   * `brickCount <= maxInitBricks`.
   */
  lod?: number;
  /** Max bricks to fully sample when auto-picking LOD (default 216). */
  maxInitBricks?: number;
  /** Skip voxels with opacity below this after TF/window (default 0.02) */
  opacityThreshold?: number;
  /** Max Gaussians to emit (subsample if exceeded; default 1_000_000) */
  maxSplats?: number;
  /** Channel index for single-channel sampling (default 0) */
  channelIndex?: number;
  /** Atlas texture format — r16float bricks store float16 bits, not 0–65535. */
  targetFormat?: GPUTextureFormat;
  isFloat?: boolean;
  floatMin?: number;
  floatMax?: number;
  numChannels?: number;
  /** Packed RGBA per channel (length ≥ 4 × numChannels), 0–1. */
  channelColors?: ArrayLike<number>;
  channelWindowCenter?: ArrayLike<number>;
  channelWindowWidth?: ArrayLike<number>;
  onProgress?: (fraction: number, label: string) => void;
}

interface VoxelSample {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  opacity: number;
  density: number;
}

interface DensityDecode {
  isFloat: boolean;
  floatMin: number;
  floatMax: number;
  /** Decode float16 bit patterns (r16float atlas). */
  f16ToF32: Float32Array | null;
}

/**
 * Decode one brick voxel to a 0–1 density, matching GPU atlas sampling.
 * r16float bricks are IEEE-754 float16 bit patterns, not uint16 intensities.
 */
export function brickValueToNormalizedDensity(
  raw: number,
  data: BrickData,
  decode: DensityDecode,
): number {
  if (decode.f16ToF32 && data instanceof Uint16Array) {
    const f = decode.f16ToF32[raw] ?? 0;
    if (!Number.isFinite(f)) return 0;
    if (decode.isFloat) {
      const range = decode.floatMax - decode.floatMin;
      return range > 0
        ? Math.min(1, Math.max(0, (f - decode.floatMin) / range))
        : 0;
    }
    return Math.min(1, Math.max(0, f));
  }
  const maxVal = data instanceof Uint8Array ? 255 : 65535;
  return raw / maxVal;
}

/**
 * Additive multi-channel composite matching `composeSampleAdditive` in DVR:
 * colour = Σ(density × rgb × a) / max(density), opacity = max(density).
 */
export function compositeMultichannelSample(
  densities: ArrayLike<number>,
  channelColors: ArrayLike<number>,
  count: number,
): { r: number; g: number; b: number; opacity: number } | null {
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let maxD = 0;
  for (let ch = 0; ch < count; ch++) {
    const a = channelColors[ch * 4 + 3] ?? 0;
    if (a <= 0) continue;
    const d = densities[ch] ?? 0;
    if (d <= 0) continue;
    wr += d * (channelColors[ch * 4] ?? 0) * a;
    wg += d * (channelColors[ch * 4 + 1] ?? 0) * a;
    wb += d * (channelColors[ch * 4 + 2] ?? 0) * a;
    maxD = Math.max(maxD, d);
  }
  if (maxD <= 0) return null;
  return {
    r: Math.min(1, wr / maxD),
    g: Math.min(1, wg / maxD),
    b: Math.min(1, wb / maxD),
    opacity: Math.min(1, maxD),
  };
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function makeDensityDecode(
  meta: { bitDepth: number; isFloat?: boolean },
  opts: InitPlyOptions,
): DensityDecode {
  const isFloat = opts.isFloat ?? meta.isFloat ?? false;
  const targetFormat = opts.targetFormat ?? "r16float";
  const isUint16AsFloat16 =
    !isFloat && meta.bitDepth === 16 && targetFormat === "r16float";
  const needF16 = isFloat || isUint16AsFloat16 || targetFormat === "r16float";
  return {
    isFloat,
    floatMin: opts.floatMin ?? 0,
    floatMax: opts.floatMax ?? 1,
    f16ToF32: needF16 ? getFloat16ToFloat32Lut() : null,
  };
}

/**
 * Finest LOD index whose brick count is within `maxBricks`.
 * Smaller index = finer. Falls back to `maxLod` if every level is larger.
 */
export function pickInitPlyLod(
  levels: Array<{ lod: number; brickCount: number }>,
  maxLod: number,
  maxBricks: number = DEFAULT_MAX_INIT_BRICKS,
): number {
  let chosen = maxLod;
  for (const level of levels) {
    if (level.brickCount <= maxBricks && level.lod < chosen) {
      chosen = level.lod;
    }
  }
  return chosen;
}

/**
 * Build an init.ply by sampling bricks at the finest affordable LOD through
 * the current transfer function / window (single-channel) or per-channel
 * colours (multi). Positions are in kiln normalized coordinates.
 *
 * If the TF/opacity curve yields no voxels, falls back to a density percentile
 * while keeping the sampled colour (not a grayscale remap).
 */
export async function buildVoxelInitPly(
  provider: DataProvider,
  config: DatasetConfig,
  tf: TransferFunction,
  windowCenter: number,
  windowWidth: number,
  opts: InitPlyOptions = {},
): Promise<Uint8Array> {
  const meta = provider.getMetadata();
  const opacityThreshold = opts.opacityThreshold ?? 0.02;
  const maxSplats = opts.maxSplats ?? DEFAULT_MAX_SPLATS;
  const decode = makeDensityDecode(meta, opts);

  const autoLod = pickInitPlyLod(
    meta.levels,
    meta.maxLod,
    opts.maxInitBricks ?? DEFAULT_MAX_INIT_BRICKS,
  );
  // Explicit lod is clamped so we never fetch a finer grid than the budget.
  const preferred =
    opts.lod !== undefined ? Math.max(opts.lod, autoLod) : autoLod;
  opts.onProgress?.(
    0.02,
    `Sampling LOD ${preferred} (${meta.levels.find((l) => l.lod === preferred)?.brickCount ?? "?"} bricks)…`,
  );
  const lodOrder: number[] = [];
  for (let l = preferred; l <= meta.maxLod; l++) lodOrder.push(l);

  let samples: VoxelSample[] = [];
  let scale = 0.01;
  let usedLod = lodOrder[0] ?? 0;

  for (const lod of lodOrder) {
    const result = await sampleLod(
      provider,
      config,
      tf,
      windowCenter,
      windowWidth,
      lod,
      decode,
      opts,
    );
    samples = result.samples;
    scale = result.scale;
    usedLod = lod;
    if (samples.length > 0) break;
  }

  let splats: GaussianSplat[] = samples
    .filter((s) => s.opacity >= opacityThreshold)
    .map((s) => ({
      x: s.x,
      y: s.y,
      z: s.z,
      r: s.r,
      g: s.g,
      b: s.b,
      opacity: s.opacity,
      sx: scale,
      sy: scale,
      sz: scale,
    }));

  // TF curve often zeros out dim fluorescence — keep brightest voxels instead.
  if (splats.length === 0 && samples.length > 0) {
    const densities = samples.map((s) => s.density).sort((a, b) => a - b);
    const firstNonzero = densities.findIndex((d) => d > 1e-6);
    const pool = firstNonzero >= 0 ? densities.slice(firstNonzero) : densities;
    const floor = Math.max(pool[Math.floor(pool.length * 0.85)] ?? 0, 1e-4);
    splats = samples
      .filter((s) => s.density >= floor)
      .map((s) => {
        const t = Math.min(1, s.density);
        return {
          x: s.x,
          y: s.y,
          z: s.z,
          r: s.r,
          g: s.g,
          b: s.b,
          opacity: Math.min(0.9, Math.max(s.opacity, 0.15 + t * 0.85)),
          sx: scale,
          sy: scale,
          sz: scale,
        };
      });
    console.warn(
      `[Kiln] init.ply: TF opacity filtered everything; kept ${splats.length} voxels by density ≥ ${floor.toFixed(4)} (LOD ${usedLod})`,
    );
  } else {
    console.log(
      `[Kiln] init.ply: ${splats.length} gaussians from LOD ${usedLod} (${samples.length} voxels sampled)`,
    );
  }

  if (splats.length > maxSplats) {
    const step = Math.ceil(splats.length / maxSplats);
    splats = splats.filter((_, i) => i % step === 0).slice(0, maxSplats);
  }

  if (splats.length === 0) {
    console.warn(
      "[Kiln] init.ply: no voxels found — check channel visibility / data range",
    );
  }

  return writeGaussianPly(splats);
}

async function sampleLod(
  provider: DataProvider,
  config: DatasetConfig,
  tf: TransferFunction,
  windowCenter: number,
  windowWidth: number,
  lod: number,
  decode: DensityDecode,
  opts: InitPlyOptions,
): Promise<{ samples: VoxelSample[]; scale: number }> {
  const meta = provider.getMetadata();
  const level =
    meta.levels.find((l) => l.lod === lod) ??
    meta.levels[meta.levels.length - 1];
  if (!level) return { samples: [], scale: 0.01 };

  const [gridX, gridY, gridZ] = level.brickGrid;
  const [nx, ny, nz] = config.normalizedSize;
  const [dx, dy, dz] = level.dimensions;
  const vx = nx / dx;
  const vy = ny / dy;
  const vz = nz / dz;
  const phys = PHYSICAL_BRICK_SIZE;
  const logical = LOGICAL_BRICK_SIZE;
  const maxSplats = opts.maxSplats ?? DEFAULT_MAX_SPLATS;
  const estVoxels = gridX * gridY * gridZ * logical * logical * logical;
  const stride = Math.max(1, Math.ceil(Math.cbrt(estVoxels / (maxSplats * 2))));
  const scale = Math.max(vx, vy, vz) * 0.55 * stride;

  const numChannels = Math.min(
    MAX_CHANNELS,
    Math.max(1, opts.numChannels ?? meta.numChannels ?? 1),
  );
  const isMulti = numChannels > 1;
  const channelColors = opts.channelColors ?? DEFAULT_CHANNEL_COLORS;
  const channelIndex = opts.channelIndex ?? 0;

  const visible: number[] = [];
  if (isMulti) {
    for (let ch = 0; ch < numChannels; ch++) {
      if ((channelColors[ch * 4 + 3] ?? 0) > 0) visible.push(ch);
    }
    if (visible.length === 0) return { samples: [], scale };
  } else {
    visible.push(channelIndex);
  }

  const chLower = new Float32Array(numChannels);
  const chInvWidth = new Float32Array(numChannels);
  for (let ch = 0; ch < numChannels; ch++) {
    const ww = Math.max(1e-4, opts.channelWindowWidth?.[ch] ?? windowWidth);
    const wc = opts.channelWindowCenter?.[ch] ?? windowCenter;
    chLower[ch] = wc - ww * 0.5;
    chInvWidth[ch] = 1 / ww;
  }

  const winMin = windowCenter - windowWidth / 2;
  const winRange = Math.max(1e-6, windowWidth);

  const samples: VoxelSample[] = [];
  const densities = new Float32Array(numChannels);
  const totalBricks = gridX * gridY * gridZ;
  let brickIndex = 0;
  const onProgress = opts.onProgress;

  for (let bz = 0; bz < gridZ; bz++) {
    for (let by = 0; by < gridY; by++) {
      for (let bx = 0; bx < gridX; bx++) {
        brickIndex++;
        onProgress?.(
          brickIndex / totalBricks,
          `LOD ${lod}: brick ${brickIndex}/${totalBricks}`,
        );
        if (brickIndex % 2 === 1) await yieldToUi();

        // Threshold 1 — streaming's emptyBrickThreshold (often 100) skips
        // dim-but-visible fluorescence and produced empty init.ply files.
        const empty = await provider.isBrickEmpty(lod, bx, by, bz, 1);
        if (empty) continue;

        const bricks = await Promise.all(
          visible.map((ch) => provider.loadBrick(lod, bx, by, bz, ch)),
        );
        if (bricks.every((b) => !b)) continue;

        for (let lz = 0; lz < logical; lz++) {
          const gz = bz * logical + lz;
          if (gz >= dz) continue;
          for (let ly = 0; ly < logical; ly++) {
            const gy = by * logical + ly;
            if (gy >= dy) continue;
            for (let lx = 0; lx < logical; lx++) {
              const gx = bx * logical + lx;
              if (gx >= dx) continue;
              if (
                stride > 1 &&
                (gx % stride !== 0 || gy % stride !== 0 || gz % stride !== 0)
              ) {
                continue;
              }

              const px = lx + 1;
              const py = ly + 1;
              const pz = lz + 1;
              const idx = pz * phys * phys + py * phys + px;

              const x = (gx + 0.5) * vx - nx / 2;
              const y = (gy + 0.5) * vy - ny / 2;
              const z = (gz + 0.5) * vz - nz / 2;

              if (isMulti) {
                densities.fill(0);
                for (let vi = 0; vi < visible.length; vi++) {
                  const brick = bricks[vi];
                  if (!brick) continue;
                  const raw = brick.data[idx] ?? 0;
                  const density = brickValueToNormalizedDensity(
                    raw,
                    brick.data,
                    decode,
                  );
                  if (density <= 0) continue;
                  const ch = visible[vi]!;
                  densities[ch] = Math.min(
                    1,
                    Math.max(0, (density - chLower[ch]!) * chInvWidth[ch]!),
                  );
                }
                const composed = compositeMultichannelSample(
                  densities,
                  channelColors,
                  numChannels,
                );
                if (!composed) continue;
                samples.push({
                  x,
                  y,
                  z,
                  r: composed.r,
                  g: composed.g,
                  b: composed.b,
                  opacity: composed.opacity,
                  density: composed.opacity,
                });
              } else {
                const brick = bricks[0];
                if (!brick) continue;
                const raw = brick.data[idx] ?? 0;
                const density = brickValueToNormalizedDensity(
                  raw,
                  brick.data,
                  decode,
                );
                if (density <= 0) continue;
                const t = Math.min(
                  1,
                  Math.max(0, (density - winMin) / winRange),
                );
                const [r, g, b, opacity] = tf.sampleRgba(t);
                samples.push({ x, y, z, r, g, b, opacity, density });
              }
            }
          }
        }
      }
    }
  }

  return { samples, scale };
}
