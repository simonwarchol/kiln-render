import { unzlibSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { mat4 } from "wgpu-matrix";

// kernel.ts reads WebGPU usage flags at import time.
let mod: typeof import("../src/splat/brush-trainer");
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, MAP_READ: 1 };
  mod = await import("../src/splat/brush-trainer");
});

describe("Brush dataset export", () => {
  it("camera-to-world rows invert Kiln's view (Nerfstudio convention)", () => {
    const eye = [0.3, -0.7, 1.9];
    const view = mat4.lookAt(eye, [0.1, 0, 0], [0, 1, 0]);
    const rows = mod.cameraToWorldRows(view);
    // Translation column is the eye; last row is (0, 0, 0, 1).
    for (let i = 0; i < 3; i++) expect(rows[i]![3]).toBeCloseTo(eye[i]!, 5);
    expect(rows[3]).toEqual([0, 0, 0, 1]);
    // Camera −z (OpenGL forward) points at the target.
    const fwd = [-rows[0]![2]!, -rows[1]![2]!, -rows[2]![2]!];
    const to = [0.1 - eye[0]!, -eye[1]!, -eye[2]!];
    const len = Math.hypot(...to);
    for (let i = 0; i < 3; i++) expect(fwd[i]).toBeCloseTo(to[i]! / len, 5);
  });

  it("writes a valid straight-alpha RGBA PNG", () => {
    const w = 3;
    const h = 2;
    const rgba = Uint8Array.from(
      { length: w * h * 4 },
      (_, i) => (i * 37) & 255,
    );
    const png = mod.encodePng(rgba, w, h);
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe("IHDR");
    expect(view.getUint32(16)).toBe(w);
    expect(view.getUint32(20)).toBe(h);
    expect(png[25]).toBe(6); // RGBA
    const idatLen = view.getUint32(33);
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe("IDAT");
    const raw = unzlibSync(png.subarray(41, 41 + idatLen));
    for (let y = 0; y < h; y++) {
      expect(raw[y * (w * 4 + 1)]).toBe(0); // filter: none
      expect(
        Array.from(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1))),
      ).toEqual(Array.from(rgba.subarray(y * w * 4, (y + 1) * w * 4)));
    }
  });
});
