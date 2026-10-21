import { describe, expect, it } from "vitest";
import { ssimReference } from "../src/splat/ssim-reference";

describe("D-SSIM reference", () => {
  it("is 1 for identical images", () => {
    const w = 12;
    const h = 9;
    const x = Array.from(
      { length: w * h * 4 },
      (_, i) => 0.5 + 0.4 * Math.sin(i),
    );
    expect(ssimReference(x, x, w, h).ssim).toBeCloseTo(1, 6);
  });

  it("analytic gradient matches finite differences", () => {
    const w = 14;
    const h = 10;
    const x = Array.from(
      { length: w * h * 4 },
      (_, i) => 0.5 + 0.3 * Math.sin(i * 0.7),
    );
    const y = Array.from(
      { length: w * h * 4 },
      (_, i) => 0.5 + 0.3 * Math.cos(i * 0.31),
    );
    const { grad } = ssimReference(x, y, w, h);
    const L = (xs: number[]) => 1 - ssimReference(xs, y, w, h).ssim;
    const eps = 1e-6;
    for (const i of [0, 17, 133, 250, 401, w * h * 4 - 1]) {
      const a = x.slice();
      a[i] = x[i]! + eps;
      const b = x.slice();
      b[i] = x[i]! - eps;
      const fd = (L(a) - L(b)) / (2 * eps);
      expect(grad[i]).toBeCloseTo(fd, 7);
    }
  });
});
