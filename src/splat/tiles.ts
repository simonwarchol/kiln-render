/**
 * Tiled splat building: each tile of the region is fit and trained on its
 * own (the fit and the training views both follow the renderer's clip box),
 * so its close-up views see the tile at a finer pyramid level than views of
 * the whole region can. Tiles train with a margin and keep only the
 * Gaussians whose centres fall inside the tile, so neighbours meet without
 * doubled seams.
 */

import { PARAM_STRIDE } from "./cpu-reference.js";

export type Vec3 = [number, number, number];
export type Box = { min: Vec3; max: Vec3 };
/**
 * `train` is the clip box a tile is built with. `core` is the part it keeps;
 * faces on the region's boundary are open (±Infinity), since no neighbour
 * owns Gaussians that spill past them.
 */
export type TileBox = { core: Box; train: Box };

/** Margin around each tile while building, as a fraction of the volume. */
export const TILE_MARGIN = 0.04;

/** Split the `splits` longest normalised axes in two (a thin stack splits x and y). */
export function chooseTiles(normalizedSize: Vec3, splits: number): Vec3 {
  const order = [0, 1, 2].sort(
    (a, b) => normalizedSize[b]! - normalizedSize[a]!,
  );
  const tiles: Vec3 = [1, 1, 1];
  for (const axis of order.slice(0, Math.max(0, Math.min(3, splits)))) {
    tiles[axis] = 2;
  }
  return tiles;
}

/** Tiles of `region` (clip space, 0…1 per axis), x fastest. */
export function tileBoxes(
  tiles: Vec3,
  region: Box = { min: [0, 0, 0], max: [1, 1, 1] },
  margin = TILE_MARGIN,
): TileBox[] {
  const along = (a: number, i: number) => {
    const n = tiles[a]!;
    const r0 = region.min[a]!;
    const r1 = region.max[a]!;
    const lo = r0 + ((r1 - r0) * i) / n;
    const hi = r0 + ((r1 - r0) * (i + 1)) / n;
    return {
      core: [i === 0 ? -Infinity : lo, i === n - 1 ? Infinity : hi],
      train: [Math.max(r0, lo - margin), Math.min(r1, hi + margin)],
    };
  };
  const out: TileBox[] = [];
  for (let k = 0; k < tiles[2]; k++)
    for (let j = 0; j < tiles[1]; j++)
      for (let i = 0; i < tiles[0]; i++) {
        const x = along(0, i);
        const y = along(1, j);
        const z = along(2, k);
        out.push({
          core: {
            min: [x.core[0]!, y.core[0]!, z.core[0]!],
            max: [x.core[1]!, y.core[1]!, z.core[1]!],
          },
          train: {
            min: [x.train[0]!, y.train[0]!, z.train[0]!],
            max: [x.train[1]!, y.train[1]!, z.train[1]!],
          },
        });
      }
  return out;
}

/**
 * Concatenate tile parameters, keeping each tile's Gaussians whose mean lies
 * in its core box (half-open, so a Gaussian on a shared face is kept once).
 * Means are in world units: (clip − 0.5) · normalizedSize.
 */
export function mergeTileParams(
  parts: { params: Float32Array; count: number; core: Box }[],
  normalizedSize: Vec3,
): { params: Float32Array; count: number } {
  const keep = parts.map(({ params, count, core }) => {
    const lo = core.min.map((c, a) => (c - 0.5) * normalizedSize[a]!);
    const hi = core.max.map((c, a) => (c - 0.5) * normalizedSize[a]!);
    const idx: number[] = [];
    for (let g = 0; g < count; g++) {
      const o = g * PARAM_STRIDE;
      let inside = true;
      for (let a = 0; a < 3 && inside; a++) {
        const v = params[o + a]!;
        inside = v >= lo[a]! && v < hi[a]!;
      }
      if (inside) idx.push(g);
    }
    return idx;
  });
  const count = keep.reduce((n, k) => n + k.length, 0);
  const params = new Float32Array(count * PARAM_STRIDE);
  let at = 0;
  parts.forEach(({ params: src }, p) => {
    for (const g of keep[p]!) {
      params.set(
        src.subarray(g * PARAM_STRIDE, (g + 1) * PARAM_STRIDE),
        at * PARAM_STRIDE,
      );
      at++;
    }
  });
  return { params, count };
}
