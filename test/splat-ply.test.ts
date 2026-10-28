import { describe, expect, it } from "vitest";
import {
  createCloud,
  mergeClouds,
  readPly,
  setGaussian,
  splitByChannel,
  writePly,
} from "../src/splat/cloud";
import { P_CHANNEL, PARAM_STRIDE } from "../src/splat/cpu-reference";

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

  it("round-trips per-channel clouds (channel property + composite)", () => {
    const a = createCloud(2);
    const b = createCloud(3);
    for (let i = 0; i < 2; i++) a.params[i * PARAM_STRIDE] = i;
    for (let i = 0; i < 3; i++) b.params[i * PARAM_STRIDE] = 10 + i;
    const merged = mergeClouds([a, b], [0, 4], "add");
    expect(merged.count).toBe(5);
    expect(merged.channelComposite).toBe("add");
    const back = readPly(writePly(merged));
    expect(back.channelComposite).toBe("add");
    const parts = splitByChannel(back);
    expect([...parts.keys()].sort()).toEqual([0, 4]);
    expect(parts.get(0)!.count).toBe(2);
    expect(parts.get(4)!.count).toBe(3);
    expect(parts.get(4)!.params[0]).toBeCloseTo(10);
    expect(parts.get(4)!.params[P_CHANNEL]).toBe(4);
  });

  it("tags channels while merging, and splits them back", () => {
    const a = createCloud(2);
    const b = createCloud(3);
    a.params[P_CHANNEL] = 9; // overwritten by the slot
    for (let i = 0; i < 3; i++) b.params[i * PARAM_STRIDE + 1] = 20 + i;
    const merged = mergeClouds([a, b, a], [1, 3, 1], "over");
    expect(merged.count).toBe(7);
    expect(merged.channelComposite).toBe("over");
    const slots = Array.from(
      { length: 7 },
      (_, i) => merged.params[i * PARAM_STRIDE + P_CHANNEL],
    );
    expect(slots).toEqual([1, 1, 3, 3, 3, 1, 1]);
    expect(a.params[P_CHANNEL]).toBe(9); // inputs untouched
    const parts = splitByChannel(merged);
    expect(parts.get(1)!.count).toBe(4);
    expect(
      Array.from(
        { length: 3 },
        (_, i) => parts.get(3)!.params[i * PARAM_STRIDE + 1],
      ),
    ).toEqual([20, 21, 22]);
    // Plain merge keeps the parts' channel params and metadata.
    expect(mergeClouds([a, b]).channelComposite).toBeUndefined();
  });

  it("aligns the float body and reads it in place", () => {
    for (const worldUnit of ["µm", "micron", "nm"]) {
      const c = createCloud(4);
      c.worldScale = 12.5;
      c.worldUnit = worldUnit;
      for (let i = 0; i < 4; i++) c.params[i * PARAM_STRIDE + 1] = i * 0.25;
      const ply = writePly(c);
      const text = new TextDecoder().decode(ply);
      const headerLen = text.indexOf("end_header\n") + "end_header\n".length;
      expect(
        new TextEncoder().encode(text.slice(0, headerLen)).length % 4,
      ).toBe(0);
      const back = readPly(ply);
      expect(back.worldUnit).toBe(worldUnit);
      expect(back.params[3 * PARAM_STRIDE + 1]).toBe(0.75);
    }
  });

  it("scales colours on export", () => {
    const c = createCloud(1);
    setGaussian(c, 0, {
      x: 0,
      y: 0,
      z: 0,
      sx: 0.01,
      sy: 0.01,
      sz: 0.01,
      qw: 1,
      qx: 0,
      qy: 0,
      qz: 0,
      r: 2,
      g: 0.5,
      b: 1,
      opacity: 0.5,
    });
    const back = readPly(writePly(c, 0.5));
    expect(Math.exp(back.params[10]!)).toBeCloseTo(1, 5);
    expect(Math.exp(back.params[11]!)).toBeCloseTo(0.25, 5);
  });

  it("writes plain clouds without the channel property", () => {
    const text = new TextDecoder().decode(
      writePly(createCloud(1)).subarray(0, 600),
    );
    expect(text).not.toContain("channel");
  });
});
