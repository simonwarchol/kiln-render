import { describe, expect, it } from "vitest";
import {
  brickValueToNormalizedDensity,
  compositeMultichannelSample,
  pickInitPlyLod,
} from "../src/export/init-ply.js";
import {
  float32ToFloat16Bits,
  getFloat16ToFloat32Lut,
} from "../src/utils/float16.js";

const f16ToF32 = getFloat16ToFloat32Lut();

describe("brickValueToNormalizedDensity", () => {
  it("decodes r16float bit patterns instead of treating them as uint16 intensities", () => {
    const bits = float32ToFloat16Bits(0.5);
    const data = new Uint16Array([bits]);
    const density = brickValueToNormalizedDensity(bits, data, {
      isFloat: false,
      floatMin: 0,
      floatMax: 1,
      f16ToF32,
    });
    expect(density).toBeCloseTo(0.5, 3);
    expect(density).not.toBeCloseTo(bits / 65535, 2);
  });

  it("normalises uint8 bricks by 255", () => {
    const data = new Uint8Array([128]);
    const density = brickValueToNormalizedDensity(128, data, {
      isFloat: false,
      floatMin: 0,
      floatMax: 1,
      f16ToF32: null,
    });
    expect(density).toBeCloseTo(128 / 255, 5);
  });
});

describe("compositeMultichannelSample", () => {
  it("matches DVR additive compositing for blue + yellow channels", () => {
    // ch0 blue (0,0,1,1), ch1 yellow (1,1,0,1)
    const colors = [0, 0, 1, 1, 1, 1, 0, 1];
    const composed = compositeMultichannelSample([1, 0.5], colors, 2);
    expect(composed).not.toBeNull();
    // weighted = 1*(0,0,1) + 0.5*(1,1,0) = (0.5, 0.5, 1); maxD = 1
    expect(composed!.r).toBeCloseTo(0.5, 5);
    expect(composed!.g).toBeCloseTo(0.5, 5);
    expect(composed!.b).toBeCloseTo(1, 5);
    expect(composed!.opacity).toBeCloseTo(1, 5);
  });

  it("skips hidden channels (alpha 0)", () => {
    const colors = [0, 0, 1, 0, 1, 0, 0, 1];
    const composed = compositeMultichannelSample([1, 0.4], colors, 2);
    expect(composed).not.toBeNull();
    expect(composed!.r).toBeCloseTo(1, 5);
    expect(composed!.g).toBeCloseTo(0, 5);
    expect(composed!.b).toBeCloseTo(0, 5);
    expect(composed!.opacity).toBeCloseTo(0.4, 5);
  });
});

describe("pickInitPlyLod", () => {
  it("picks the finest level that still fits the brick budget", () => {
    const levels = [
      { lod: 0, brickCount: 512 },
      { lod: 1, brickCount: 64 },
      { lod: 2, brickCount: 8 },
    ];
    expect(pickInitPlyLod(levels, 2, 216)).toBe(1);
    expect(pickInitPlyLod(levels, 2, 8)).toBe(2);
    expect(pickInitPlyLod(levels, 2, 512)).toBe(0);
  });

  it("falls back to maxLod when every level exceeds the budget", () => {
    const levels = [{ lod: 0, brickCount: 1000 }];
    expect(pickInitPlyLod(levels, 0, 64)).toBe(0);
  });
});
