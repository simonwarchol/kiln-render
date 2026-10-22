import { describe, expect, it } from "vitest";
import { mat4 } from "wgpu-matrix";
import {
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
});
