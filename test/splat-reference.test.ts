import { describe, expect, it } from "vitest";
import { mat4 } from "wgpu-matrix";
import {
  type Blend,
  backwardReference,
  intrinsicsFor,
  PARAM_STRIDE,
  renderReference,
} from "../src/splat/cpu-reference";

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scene(seed: number, count: number) {
  const rand = mulberry32(seed);
  const p = new Float64Array(count * PARAM_STRIDE);
  for (let g = 0; g < count; g++) {
    const b = g * PARAM_STRIDE;
    p[b] = (rand() - 0.5) * 0.6;
    p[b + 1] = (rand() - 0.5) * 0.5;
    p[b + 2] = (rand() - 0.5) * 0.6;
    p[b + 3] = Math.log(0.05 + rand() * 0.1);
    p[b + 4] = Math.log(0.03 + rand() * 0.1);
    p[b + 5] = Math.log(0.04 + rand() * 0.1);
    p[b + 6] = 0.5 + rand();
    p[b + 7] = rand() - 0.5;
    p[b + 8] = rand() - 0.5;
    p[b + 9] = rand() - 0.5;
    p[b + 10] = (rand() - 0.5) * 3;
    p[b + 11] = (rand() - 0.5) * 3;
    p[b + 12] = (rand() - 0.5) * 3;
    p[b + 13] = -0.5 + rand() * 1.5;
  }
  return p;
}

const W = 40;
const H = 30;

function camera(eye: [number, number, number]) {
  const view = mat4.lookAt(eye, [0, 0, 0], [0, -1, 0]);
  return intrinsicsFor(Array.from(view), W, H);
}

function loss(
  p: ArrayLike<number>,
  count: number,
  cam: ReturnType<typeof camera>,
  w: Float64Array,
  blend: Blend = "alpha",
) {
  const r = renderReference(p, count, cam, blend);
  let l = 0;
  for (let i = 0; i < r.image.length; i++) l += r.image[i]! * w[i]!;
  return l;
}

describe("splat CPU reference", () => {
  it("renders something inside the frame", () => {
    const p = scene(1, 5);
    const cam = camera([0.3, -0.4, 1.8]);
    const r = renderReference(p, 5, cam);
    let sumA = 0;
    for (let i = 3; i < r.image.length; i += 4) sumA += r.image[i]!;
    expect(sumA).toBeGreaterThan(5);
    expect(r.order.length).toBe(5);
  });

  for (const [seed, eye, blend] of [
    [2, [0.3, -0.4, 1.8], "alpha"],
    [3, [-1.2, 0.5, 1.1], "alpha"],
    [4, [0.1, 1.5, 0.6], "alpha"],
    [5, [0.3, -0.4, 1.8], "max"],
    [6, [-1.2, 0.5, 1.1], "max"],
  ] as const) {
    it(`analytic gradients match finite differences (${blend}, seed ${seed})`, () => {
      const count = 4;
      const p = scene(seed, count);
      const cam = camera(eye as unknown as [number, number, number]);
      const rand = mulberry32(seed + 100);
      const w = new Float64Array(W * H * 4);
      for (let i = 0; i < w.length; i++) w[i] = rand() - 0.5;
      const grad = backwardReference(
        p,
        count,
        cam,
        w,
        renderReference(p, count, cam, blend),
      );
      const eps = 1e-5;
      let checked = 0;
      let maxRel = 0;
      for (let g = 0; g < count; g++) {
        for (let k = 0; k < 14; k++) {
          const i = g * PARAM_STRIDE + k;
          const q = Float64Array.from(p);
          q[i] = p[i]! + eps;
          const lp = loss(q, count, cam, w, blend);
          q[i] = p[i]! - eps;
          const lm = loss(q, count, cam, w, blend);
          const fd = (lp - lm) / (2 * eps);
          const an = grad[i]!;
          const scale = Math.max(1e-2, Math.abs(fd), Math.abs(an));
          const rel = Math.abs(fd - an) / scale;
          maxRel = Math.max(maxRel, rel);
          if (rel > 2e-2) {
            throw new Error(
              `param g${g}[${k}] analytic ${an.toExponential(4)} vs fd ${fd.toExponential(4)}`,
            );
          }
          checked++;
        }
      }
      expect(checked).toBe(count * 14);
      expect(maxRel).toBeLessThan(2e-2);
    });
  }
});
