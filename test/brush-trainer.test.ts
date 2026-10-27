import { beforeAll, describe, expect, it } from "vitest";
import { mat4 } from "wgpu-matrix";

// kernel.ts reads WebGPU usage flags at import time.
let mod: typeof import("../src/splat/brush-trainer");
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, MAP_READ: 1 };
  mod = await import("../src/splat/brush-trainer");
});

describe("Brush splats → Kiln", () => {
  it("converts layout and colour gain, dropping splats with NaN values", () => {
    const n = 3;
    // means(3) | quat wxyz(4) | log scales(3)
    const transforms = new Float32Array(n * 10);
    for (let i = 0; i < n; i++)
      transforms.set([i, 0.5, -1, 1, 0, 0, 0, -3, -4, -5], i * 10);
    const sh = new Float32Array(n * 3).fill(0); // DC 0 → colour 0.5
    sh[3] = Number.NaN; // splat 1: NaN colour (seen from Brush)
    const opacity = Float32Array.from([0.2, 0.3, 0.4]);
    const { params, count } = mod.kilnParamsFromBrush(
      transforms,
      sh,
      opacity,
      n,
      1,
      2,
    );
    expect(count).toBe(2);
    expect(params.length).toBe(2 * 16);
    expect(Array.from(params).every(Number.isFinite)).toBe(true);
    // Kept splats 0 and 2, in order.
    expect(params[0]).toBe(0);
    expect(params[16]).toBe(2);
    expect(Array.from(params.subarray(16 + 3, 16 + 6))).toEqual([-3, -4, -5]);
    expect(params[16 + 6]).toBe(1); // quat w
    expect(params[16 + 13]).toBeCloseTo(0.4);
    // colour = exp(param) = gain · (0.5 + C0 · DC) = 1
    expect(Math.exp(params[16 + 10]!)).toBeCloseTo(1);
  });
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

  it("writes a valid straight-alpha RGBA PNG", async () => {
    const w = 3;
    const h = 2;
    const rgba = Uint8Array.from(
      { length: w * h * 4 },
      (_, i) => (i * 37) & 255,
    );
    const png = await mod.encodePng(rgba, w, h);
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
    const raw = new Uint8Array(
      await new Response(
        new Blob([png.subarray(41, 41 + idatLen)])
          .stream()
          .pipeThrough(new DecompressionStream("deflate")),
      ).arrayBuffer(),
    );
    for (let y = 0; y < h; y++) {
      expect(raw[y * (w * 4 + 1)]).toBe(0); // filter: none
      expect(
        Array.from(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1))),
      ).toEqual(Array.from(rgba.subarray(y * w * 4, (y + 1) * w * 4)));
    }
  });
});
