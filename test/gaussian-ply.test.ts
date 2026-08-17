import { describe, expect, it } from "vitest";
import { writeGaussianPly } from "../src/export/gaussian-ply.js";

describe("writeGaussianPly", () => {
  it("writes a binary 3DGS PLY with the expected header", () => {
    const ply = writeGaussianPly([
      {
        x: 0.1,
        y: 0.2,
        z: 0.3,
        r: 1,
        g: 0,
        b: 0,
        opacity: 0.8,
        sx: 0.01,
        sy: 0.01,
        sz: 0.01,
      },
    ]);
    const text = new TextDecoder().decode(ply.subarray(0, 800));
    expect(text.startsWith("ply\n")).toBe(true);
    expect(text).toContain("format binary_little_endian 1.0");
    expect(text).toContain("element vertex 1");
    expect(text).toContain("property float f_dc_0");
    expect(text).toContain("property float opacity");
    expect(text).toContain("property float scale_0");
    expect(text).toContain("property float rot_0");
    expect(text).toContain("end_header\n");
  });

  it("encodes linear RGB as 3DGS spherical-harmonic DC", () => {
    const ply = writeGaussianPly([
      {
        x: 0,
        y: 0,
        z: 0,
        r: 1,
        g: 0,
        b: 0,
        opacity: 0.5,
        sx: 0.01,
        sy: 0.01,
        sz: 0.01,
      },
    ]);
    const head = new TextDecoder().decode(ply.subarray(0, 800));
    const marker = "end_header\n";
    const bodyOffset = head.indexOf(marker) + marker.length;
    const view = new DataView(ply.buffer, ply.byteOffset + bodyOffset);
    const shC0 = 0.28209479177387814;
    // x,y,z,nx,ny,nz then f_dc_0 / f_dc_1
    expect(view.getFloat32(6 * 4, true)).toBeCloseTo((1 - 0.5) / shC0, 5);
    expect(view.getFloat32(7 * 4, true)).toBeCloseTo((0 - 0.5) / shC0, 5);
  });
});
