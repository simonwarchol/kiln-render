import { describe, expect, it } from "vitest";
import {
  createCloud,
  readPly,
  setGaussian,
  writePly,
} from "../src/splat/cloud";
import { PARAM_STRIDE } from "../src/splat/cpu-reference";

describe("splat PLY round trip", () => {
  it("preserves positions, scales, rotations, colours and opacity", () => {
    const c = createCloud(3);
    c.worldScale = 307.2;
    c.worldUnit = "micron";
    c.antialiased = true;
    for (let i = 0; i < 3; i++) {
      setGaussian(c, i, {
        x: i * 0.1,
        y: -0.2,
        z: 0.3,
        sx: 0.01,
        sy: 0.02 + i * 0.01,
        sz: 0.005,
        qw: 0.9,
        qx: 0.1 * i,
        qy: 0.2,
        qz: -0.1,
        r: 0.2,
        g: 0.5 + i * 0.1,
        b: 0.9,
        opacity: 0.3 + i * 0.2,
      });
    }
    const back = readPly(writePly(c));
    expect(back.count).toBe(3);
    expect(back.worldScale).toBeCloseTo(307.2);
    expect(back.worldUnit).toBe("micron");
    expect(back.antialiased).toBe(true);
    for (let i = 0; i < 3; i++) {
      const b = i * PARAM_STRIDE;
      for (const k of [0, 1, 2, 3, 4, 5, 13]) {
        expect(back.params[b + k]).toBeCloseTo(c.params[b + k]!, 4);
      }
      for (const k of [10, 11, 12]) {
        expect(Math.exp(back.params[b + k]!)).toBeCloseTo(
          Math.exp(c.params[b + k]!),
          4,
        );
      }
      // quaternion normalised on export
      const q = [6, 7, 8, 9].map((k) => c.params[b + k]!);
      const n = Math.hypot(...q);
      for (let k = 0; k < 4; k++) {
        expect(back.params[b + 6 + k]).toBeCloseTo(q[k]! / n, 5);
      }
    }
  });

  it("rejects non-PLY input", () => {
    expect(() => readPly(new TextEncoder().encode("hello"))).toThrow();
  });
});
