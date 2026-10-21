/**
 * Adaptive atlas sizing — the atlas grid shrinks with channel count so total
 * atlas VRAM stays within a budget (prevents 4-channel OOM crashes on
 * shared-memory mobile GPUs), and the chosen size is injected into the shaders.
 */
import { describe, expect, it } from "vitest";
import {
  ATLAS_BUDGET_CONSTRAINED_BYTES,
  ATLAS_BUDGET_FALLBACK_BYTES,
  computeAtlasGrid,
  DEFAULT_ATLAS_BUDGET_BYTES,
  GRID_SIZE,
  guessAtlasBudgetBytes,
  MIN_GRID_SIZE,
  nextSmallerAtlasGrid,
} from "../src/core/config.js";
import {
  buildComputeShader,
  buildSlicePlanesShader,
} from "../src/shaders/index.js";

describe("adaptive atlas sizing", () => {
  it("keeps full 660 grid for 1-2 channels (r16float) at the full budget", () => {
    expect(computeAtlasGrid(1, 2)).toEqual({ gridSize: 10, atlasSize: 660 });
    expect(computeAtlasGrid(2, 2)).toEqual({ gridSize: 10, atlasSize: 660 });
  });
  it("shrinks the grid for 4 channels under the constrained budget", () => {
    const g = computeAtlasGrid(4, 2, ATLAS_BUDGET_CONSTRAINED_BYTES);
    expect(g.gridSize).toBeLessThan(GRID_SIZE);
    expect(g.atlasSize).toBe(g.gridSize * 66);
    expect(4 * g.atlasSize ** 3 * 2).toBeLessThanOrEqual(
      ATLAS_BUDGET_CONSTRAINED_BYTES,
    );
  });
  it("never exceeds the max grid and respects an explicit budget", () => {
    expect(computeAtlasGrid(1, 2, 100).gridSize).toBe(6); // clamped to MIN
    expect(computeAtlasGrid(1, 2, 1e12).gridSize).toBe(GRID_SIZE); // clamped to MAX
  });
  it("injects the runtime atlas size into the compute + slice shaders", () => {
    expect(buildComputeShader(528)).toContain("ATLAS_SIZE: f32 = 528.0");
    expect(buildSlicePlanesShader(528)).toContain("ATLAS_SIZE: f32 = 528.0");
    expect(buildComputeShader(660)).toContain("ATLAS_SIZE: f32 = 660.0");
  });
});

describe("guessAtlasBudgetBytes", () => {
  const mib = 1024 * 1024;

  it("uses a tiny budget for fallback adapters so the grid hits MIN", () => {
    expect(
      guessAtlasBudgetBytes({
        maxBufferSize: 2 * 1024 * mib,
        isFallbackAdapter: true,
      }),
    ).toBe(ATLAS_BUDGET_FALLBACK_BYTES);
    expect(computeAtlasGrid(1, 2, ATLAS_BUDGET_FALLBACK_BYTES).gridSize).toBe(
      MIN_GRID_SIZE,
    );
  });

  it("constrains iGPU-class maxBufferSize and low deviceMemory", () => {
    expect(guessAtlasBudgetBytes({ maxBufferSize: 256 * mib })).toBe(
      ATLAS_BUDGET_CONSTRAINED_BYTES,
    );
    expect(
      guessAtlasBudgetBytes({
        maxBufferSize: 2 * 1024 * mib,
        deviceMemoryGiB: 4,
      }),
    ).toBe(ATLAS_BUDGET_CONSTRAINED_BYTES);
  });

  it("uses the full cap for large maxBufferSize without tiny RAM", () => {
    expect(
      guessAtlasBudgetBytes({ maxBufferSize: 1024 * mib, deviceMemoryGiB: 8 }),
    ).toBe(DEFAULT_ATLAS_BUDGET_BYTES);
    expect(guessAtlasBudgetBytes({ maxBufferSize: 2 * 1024 * mib })).toBe(
      DEFAULT_ATLAS_BUDGET_BYTES,
    );
  });

  it("drops one grid step down to MIN", () => {
    expect(nextSmallerAtlasGrid(10)).toBe(9);
    expect(nextSmallerAtlasGrid(MIN_GRID_SIZE)).toBeNull();
  });
});
