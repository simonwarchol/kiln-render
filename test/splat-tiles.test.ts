import { describe, expect, it } from "vitest";
import { PARAM_STRIDE } from "../src/splat/cpu-reference";
import { chooseTiles, mergeTileParams, tileBoxes } from "../src/splat/tiles";

describe("splat tiles", () => {
  it("splits the longest axes of a thin stack", () => {
    expect(chooseTiles([2, 2, 0.4], 2)).toEqual([2, 2, 1]);
    expect(chooseTiles([0.5, 2, 1], 1)).toEqual([1, 2, 1]);
    expect(chooseTiles([1, 1, 1], 0)).toEqual([1, 1, 1]);
  });

  it("covers the region with overlapping build boxes", () => {
    const boxes = tileBoxes([2, 2, 1], undefined, 0.05);
    expect(boxes).toHaveLength(4);
    expect(boxes[0]?.core).toEqual({
      min: [-Infinity, -Infinity, -Infinity],
      max: [0.5, 0.5, Infinity],
    });
    expect(boxes[0]?.train).toEqual({ min: [0, 0, 0], max: [0.55, 0.55, 1] });
    expect(boxes[3]?.train.min).toEqual([0.45, 0.45, 0]);
    // Inside a clipped region, tiles and margins stay within it.
    const [a] = tileBoxes(
      [2, 1, 1],
      { min: [0.2, 0, 0], max: [0.6, 1, 1] },
      0.05,
    );
    expect(a?.train.min[0]).toBeCloseTo(0.2);
    expect(a?.train.max[0]).toBeCloseTo(0.45);
    expect(a?.core.max[0]).toBeCloseTo(0.4);
  });

  it("keeps each tile's Gaussians inside its core, once", () => {
    const [left, right] = tileBoxes([2, 1, 1]);
    if (!left || !right) throw new Error("expected two tiles");
    const cloud = (xs: number[]) => {
      const params = new Float32Array(xs.length * PARAM_STRIDE);
      xs.forEach((x, g) => {
        params[g * PARAM_STRIDE] = x;
      });
      return { params, count: xs.length };
    };
    // World x ∈ [-1, 1): left core x < 0, right core x ≥ 0.
    const merged = mergeTileParams(
      [
        { ...cloud([-0.75, -0.125, 0, 0.0625, -5]), core: left.core },
        { ...cloud([-0.0625, 0, 0.5, 5]), core: right.core },
      ],
      [2, 2, 1],
    );
    const xs = Array.from(
      { length: merged.count },
      (_, g) => merged.params[g * PARAM_STRIDE],
    );
    expect(xs).toEqual([-0.75, -0.125, -5, 0, 0.5, 5]);
  });
});
