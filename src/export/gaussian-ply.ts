/**
 * Write a SuperSplat / Brush-compatible 3D Gaussian Splatting PLY.
 * Attributes match the INRIA 3DGS convention (f_dc_*, opacity logit, log-scale, quaternion).
 */

const SH_C0 = 0.28209479177387814;

export interface GaussianSplat {
  x: number;
  y: number;
  z: number;
  /** Linear RGB 0–1 */
  r: number;
  g: number;
  b: number;
  /** Linear opacity 0–1 */
  opacity: number;
  /** Axis-aligned scale in world units */
  sx: number;
  sy: number;
  sz: number;
}

function logit(p: number): number {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(c / (1 - c));
}

function rgbToShDc(c: number): number {
  return (c - 0.5) / SH_C0;
}

/** Encode an array of Gaussians as a binary little-endian 3DGS PLY. */
export function writeGaussianPly(splats: GaussianSplat[]): Uint8Array {
  const n = splats.length;
  const header = [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${n}`,
    "property float x",
    "property float y",
    "property float z",
    "property float nx",
    "property float ny",
    "property float nz",
    "property float f_dc_0",
    "property float f_dc_1",
    "property float f_dc_2",
    "property float opacity",
    "property float scale_0",
    "property float scale_1",
    "property float scale_2",
    "property float rot_0",
    "property float rot_1",
    "property float rot_2",
    "property float rot_3",
    "end_header\n",
  ].join("\n");

  const headerBytes = new TextEncoder().encode(header);
  // 17 floats per vertex
  const stride = 17 * 4;
  const body = new ArrayBuffer(n * stride);
  const view = new DataView(body);

  for (let i = 0; i < n; i++) {
    const s = splats[i]!;
    let o = i * stride;
    const write = (v: number) => {
      view.setFloat32(o, v, true);
      o += 4;
    };
    write(s.x);
    write(s.y);
    write(s.z);
    write(0);
    write(0);
    write(0);
    write(rgbToShDc(s.r));
    write(rgbToShDc(s.g));
    write(rgbToShDc(s.b));
    write(logit(s.opacity));
    write(Math.log(Math.max(1e-8, s.sx)));
    write(Math.log(Math.max(1e-8, s.sy)));
    write(Math.log(Math.max(1e-8, s.sz)));
    // Identity quaternion (w, x, y, z) — INRIA uses rot_0=w
    write(1);
    write(0);
    write(0);
    write(0);
  }

  const out = new Uint8Array(headerBytes.length + body.byteLength);
  out.set(headerBytes, 0);
  out.set(new Uint8Array(body), headerBytes.length);
  return out;
}

/** Trigger a browser download of binary data. */
export function downloadBytes(
  filename: string,
  data: Uint8Array,
  mime: string,
): void {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const blob = new Blob([copy], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
