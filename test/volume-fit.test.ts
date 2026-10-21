import { describe, expect, it } from "vitest";
import { P_OPACITY, PARAM_STRIDE, sigmoid } from "../src/splat/cpu-reference";
import {
  type ClassifyParams,
  rotationToQuat,
  symmetricEigen3,
  VolumeFitter,
} from "../src/splat/volume-fit";
import { float32ToFloat16Bits } from "../src/utils/float16";

describe("symmetricEigen3", () => {
  it("reconstructs the matrix and yields a rotation", () => {
    const a = [4, 1, 0.5, 1, 3, 0.2, 0.5, 0.2, 1];
    const { values, vectors: v } = symmetricEigen3(a);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++)
          s += v[i * 3 + k]! * values[k]! * v[j * 3 + k]!;
        expect(s).toBeCloseTo(a[i * 3 + j]!, 6);
      }
    const det =
      v[0]! * (v[4]! * v[8]! - v[5]! * v[7]!) -
      v[1]! * (v[3]! * v[8]! - v[5]! * v[6]!) +
      v[2]! * (v[3]! * v[7]! - v[4]! * v[6]!);
    expect(det).toBeCloseTo(1, 6);
    const q = rotationToQuat(v);
    expect(Math.hypot(...q)).toBeCloseTo(1, 6);
  });
});

function params(): ClassifyParams {
  return {
    numChannels: 1,
    channelColors: [1, 1, 1, 1],
    channelWindowCenter: [0.5],
    channelWindowWidth: [1],
    floatMin: 0,
    floatMax: 1,
    windowCenter: 0.5,
    windowWidth: 1,
    densityScale: 1,
    maxDim0: 64,
    clipMin: [0, 0, 0],
    clipMax: [1, 1, 1],
  };
}

describe("VolumeFitter", () => {
  it("conserves absorbing mass and centroid for a solid ellipsoid", () => {
    const P = 66;
    const brick = new Uint16Array(P * P * P);
    const one = float32ToFloat16Bits(0.5);
    let voxels = 0;
    let cx = 0;
    for (let z = 0; z < 64; z++)
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const u = (x + 0.5 - 40) / 12;
          const v = (y + 0.5 - 30) / 8;
          const w = (z + 0.5 - 32) / 5;
          if (u * u + v * v + w * w <= 1) {
            brick[((z + 1) * P + (y + 1)) * P + (x + 1)] = one;
            voxels++;
            cx += x + 0.5;
          }
        }
    const fitter = new VolumeFitter(
      { dims: [64, 64, 64], normalizedSize: [1, 1, 1] },
      params(),
    );
    fitter.addBrick(0, 0, 0, [brick]);
    expect(fitter.occupiedVoxels).toBe(voxels);
    const cloud = fitter.finish({ targetCount: 50 });
    expect(cloud.count).toBeGreaterThan(0);
    expect(cloud.count).toBeLessThanOrEqual(80);
    // Opacity-weighted centroid in x lands on the ellipsoid centre.
    let wsum = 0;
    let xsum = 0;
    for (let i = 0; i < cloud.count; i++) {
      const o = sigmoid(cloud.params[i * PARAM_STRIDE + P_OPACITY]!);
      wsum += o;
      xsum += o * cloud.params[i * PARAM_STRIDE]!;
    }
    const expectedX = cx / voxels / 64 - 0.5;
    expect(xsum / wsum).toBeCloseTo(expectedX, 1);
  });

  it("refines to more Gaussians when the budget grows", () => {
    const P = 66;
    const brick = new Uint16Array(P * P * P);
    for (let z = 0; z < 64; z++)
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const val = ((x >> 3) + (y >> 3) + (z >> 3)) % 2 ? 0.8 : 0.2;
          brick[((z + 1) * P + (y + 1)) * P + (x + 1)] =
            float32ToFloat16Bits(val);
        }
    const make = (n: number) => {
      const f = new VolumeFitter(
        { dims: [64, 64, 64], normalizedSize: [1, 1, 1] },
        params(),
      );
      f.addBrick(0, 0, 0, [brick]);
      return f.finish({ targetCount: n }).count;
    };
    const small = make(600);
    const big = make(20_000);
    expect(small).toBeLessThanOrEqual(600);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThanOrEqual(32_768);
  });
});
