import { describe, expect, it } from "vitest";
import {
  DEPTH_CUE_RANGE,
  depthCueFor,
  NO_DEPTH_CUE,
} from "../src/core/depth-cue.js";

const fade = (cue: { near: number; scale: number }, d: number) =>
  Math.exp(-cue.scale * Math.max(0, d - cue.near));

describe("depthCueFor", () => {
  const lo = [-0.5, -0.5, -0.5];
  const hi = [0.5, 0.5, 0.5];

  it("is off at strength 0", () => {
    expect(depthCueFor([0, 0, 3], lo, hi, 0)).toEqual(NO_DEPTH_CUE);
  });

  it("starts at the box's front face and dims its far corner by e^(-5·strength)", () => {
    const cue = depthCueFor([0, 0, 3], lo, hi, 0.5);
    expect(cue.near).toBeCloseTo(2.5);
    expect(fade(cue, 2.5)).toBeCloseTo(1);
    const farCorner = Math.hypot(0.5, 0.5, 3.5);
    expect(fade(cue, farCorner)).toBeCloseTo(Math.exp(-0.5 * DEPTH_CUE_RANGE));
  });

  it("fades from the eye when the camera is inside the box", () => {
    const cue = depthCueFor([0, 0, 0.1], lo, hi, 1);
    expect(cue.near).toBe(0);
    expect(fade(cue, Math.hypot(0.5, 0.5, 0.6))).toBeCloseTo(
      Math.exp(-DEPTH_CUE_RANGE),
    );
  });
});
