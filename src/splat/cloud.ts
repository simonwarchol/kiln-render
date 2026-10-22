/**
 * GaussianCloud — CPU-side Gaussian splat set in Kiln's training layout
 * (PARAM_STRIDE floats per Gaussian: mean, log-scale, quaternion wxyz,
 * colour logit, opacity logit), plus standard 3DGS PLY import/export.
 *
 * Positions live in Kiln's normalised volume space (centred at the origin,
 * longest physical axis = 1), so a cloud lines up with the volume it came
 * from. `worldScale` (e.g. µm per normalised unit) is written to the PLY so
 * other tools can recover physical units.
 */

import {
  colorParam,
  logit,
  P_COLOR,
  P_MEAN,
  P_OPACITY,
  P_QUAT,
  P_SCALE,
  PARAM_STRIDE,
} from "./cpu-reference.js";

const SH_C0 = 0.28209479177387814;

export interface GaussianCloud {
  count: number;
  /** count × PARAM_STRIDE floats */
  params: Float32Array;
  /**
   * Trained with Mip-Splatting dilation compensation (Kiln clouds). Ordinary
   * 3DGS files are not and should be rendered without it.
   */
  antialiased?: boolean;
  /** Physical units per normalised unit (optional metadata) */
  worldScale?: number;
  worldUnit?: string;
}

export function createCloud(count: number): GaussianCloud {
  return { count, params: new Float32Array(count * PARAM_STRIDE) };
}

/** A Kiln-built cloud (always Mip-Splatting compensated) around `params`. */
export function cloudFromParams(
  params: Float32Array,
  count: number,
  meta: Pick<GaussianCloud, "worldScale" | "worldUnit"> = {},
): GaussianCloud {
  return {
    count,
    params,
    antialiased: true,
    ...(meta.worldScale !== undefined ? { worldScale: meta.worldScale } : {}),
    ...(meta.worldUnit !== undefined ? { worldUnit: meta.worldUnit } : {}),
  };
}

export interface GaussianInit {
  x: number;
  y: number;
  z: number;
  /** linear scale (std-dev) per local axis */
  sx: number;
  sy: number;
  sz: number;
  /** rotation quaternion w, x, y, z */
  qw: number;
  qx: number;
  qy: number;
  qz: number;
  /** emission colour, linear, ≥ 0 (may exceed 1) */
  r: number;
  g: number;
  b: number;
  opacity: number;
}

export function setGaussian(
  cloud: GaussianCloud,
  i: number,
  g: GaussianInit,
): void {
  const p = cloud.params;
  const b = i * PARAM_STRIDE;
  p[b + P_MEAN] = g.x;
  p[b + P_MEAN + 1] = g.y;
  p[b + P_MEAN + 2] = g.z;
  p[b + P_SCALE] = Math.log(Math.max(1e-7, g.sx));
  p[b + P_SCALE + 1] = Math.log(Math.max(1e-7, g.sy));
  p[b + P_SCALE + 2] = Math.log(Math.max(1e-7, g.sz));
  p[b + P_QUAT] = g.qw;
  p[b + P_QUAT + 1] = g.qx;
  p[b + P_QUAT + 2] = g.qy;
  p[b + P_QUAT + 3] = g.qz;
  p[b + P_COLOR] = colorParam(g.r);
  p[b + P_COLOR + 1] = colorParam(g.g);
  p[b + P_COLOR + 2] = colorParam(g.b);
  p[b + P_OPACITY] = logit(g.opacity);
}

const PLY_PROPS = [
  "x",
  "y",
  "z",
  "nx",
  "ny",
  "nz",
  "f_dc_0",
  "f_dc_1",
  "f_dc_2",
  "opacity",
  "scale_0",
  "scale_1",
  "scale_2",
  "rot_0",
  "rot_1",
  "rot_2",
  "rot_3",
] as const;

/** Encode as a binary little-endian INRIA-style 3DGS PLY (SH degree 0). */
export function writePly(cloud: GaussianCloud): Uint8Array {
  const n = cloud.count;
  const lines = [
    "ply",
    "format binary_little_endian 1.0",
    "comment kiln-render gaussian splats",
  ];
  if (cloud.antialiased) lines.push("comment kiln mip_filter 1");
  if (cloud.worldScale) {
    lines.push(`comment kiln world_scale ${cloud.worldScale}`);
    if (cloud.worldUnit)
      lines.push(`comment kiln world_unit ${cloud.worldUnit}`);
  }
  lines.push(`element vertex ${n}`);
  for (const p of PLY_PROPS) lines.push(`property float ${p}`);
  lines.push("end_header\n");
  const header = new TextEncoder().encode(lines.join("\n"));
  const stride = PLY_PROPS.length;
  const body = new Float32Array(n * stride);
  const p = cloud.params;
  for (let i = 0; i < n; i++) {
    const b = i * PARAM_STRIDE;
    const o = i * stride;
    body[o] = p[b + P_MEAN]!;
    body[o + 1] = p[b + P_MEAN + 1]!;
    body[o + 2] = p[b + P_MEAN + 2]!;
    for (let c = 0; c < 3; c++) {
      body[o + 6 + c] = (Math.exp(p[b + P_COLOR + c]!) - 0.5) / SH_C0;
    }
    body[o + 9] = p[b + P_OPACITY]!;
    body[o + 10] = p[b + P_SCALE]!;
    body[o + 11] = p[b + P_SCALE + 1]!;
    body[o + 12] = p[b + P_SCALE + 2]!;
    const qw = p[b + P_QUAT]!;
    const qx = p[b + P_QUAT + 1]!;
    const qy = p[b + P_QUAT + 2]!;
    const qz = p[b + P_QUAT + 3]!;
    const ql = Math.hypot(qw, qx, qy, qz) || 1;
    body[o + 13] = qw / ql;
    body[o + 14] = qx / ql;
    body[o + 15] = qy / ql;
    body[o + 16] = qz / ql;
  }
  const out = new Uint8Array(header.length + body.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(body.buffer), header.length);
  return out;
}

const TYPE_SIZE: Record<string, number> = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

function reader(type: string): (v: DataView, o: number) => number {
  switch (type) {
    case "char":
    case "int8":
      return (v, o) => v.getInt8(o);
    case "uchar":
    case "uint8":
      return (v, o) => v.getUint8(o);
    case "short":
    case "int16":
      return (v, o) => v.getInt16(o, true);
    case "ushort":
    case "uint16":
      return (v, o) => v.getUint16(o, true);
    case "int":
    case "int32":
      return (v, o) => v.getInt32(o, true);
    case "uint":
    case "uint32":
      return (v, o) => v.getUint32(o, true);
    case "double":
    case "float64":
      return (v, o) => v.getFloat64(o, true);
    default:
      return (v, o) => v.getFloat32(o, true);
  }
}

/**
 * Parse a binary little-endian 3DGS PLY (INRIA layout; extra properties such
 * as higher-order SH are ignored — only the DC colour is kept).
 */
export function readPly(bytes: Uint8Array): GaussianCloud {
  const headText = new TextDecoder().decode(
    bytes.subarray(0, Math.min(bytes.length, 64 * 1024)),
  );
  const end = headText.indexOf("end_header");
  if (!headText.startsWith("ply") || end < 0) throw new Error("Not a PLY file");
  const headerLen = headText.indexOf("\n", end) + 1;
  const lines = headText.slice(0, end).split(/\r?\n/);
  if (!lines.some((l) => l.startsWith("format binary_little_endian"))) {
    throw new Error("Only binary little-endian PLY files are supported");
  }
  let count = 0;
  let inVertex = false;
  let worldScale: number | undefined;
  let worldUnit: string | undefined;
  let antialiased = false;
  const props: Array<{ name: string; type: string; offset: number }> = [];
  let stride = 0;
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "comment" && t[1] === "kiln" && t[2] === "world_scale") {
      worldScale = Number(t[3]);
    } else if (t[0] === "comment" && t[1] === "kiln" && t[2] === "mip_filter") {
      antialiased = t[3] === "1";
    } else if (t[0] === "comment" && t[1] === "kiln" && t[2] === "world_unit") {
      worldUnit = t[3];
    } else if (t[0] === "element") {
      inVertex = t[1] === "vertex";
      if (inVertex) count = Number(t[2]);
      else if (count > 0 && props.length > 0) break;
    } else if (t[0] === "property" && inVertex) {
      if (t[1] === "list")
        throw new Error("PLY list properties are not supported");
      const type = t[1]!;
      props.push({ name: t[2]!, type, offset: stride });
      stride += TYPE_SIZE[type] ?? 4;
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + headerLen);
  // All-float32 files (Kiln's, standard 3DGS) read through a Float32Array.
  const allFloat =
    stride % 4 === 0 &&
    props.every((q) => TYPE_SIZE[q.type] === 4 && /^float/.test(q.type));
  const floats = allFloat
    ? (bytes.byteOffset + headerLen) % 4 === 0
      ? new Float32Array(
          bytes.buffer,
          bytes.byteOffset + headerLen,
          (count * stride) / 4,
        )
      : new Float32Array(
          bytes.slice(headerLen, headerLen + count * stride).buffer,
        )
    : null;
  const get = (name: string) => {
    const p = props.find((q) => q.name === name);
    if (!p) return null;
    if (floats) {
      const s4 = stride / 4;
      const o4 = p.offset / 4;
      return (i: number) => floats[i * s4 + o4]!;
    }
    const r = reader(p.type);
    return (i: number) => r(view, i * stride + p.offset);
  };
  const x = get("x");
  const y = get("y");
  const z = get("z");
  if (!x || !y || !z) throw new Error("PLY has no x/y/z");
  const dc = [get("f_dc_0"), get("f_dc_1"), get("f_dc_2")];
  const rgb = [get("red"), get("green"), get("blue")];
  const op = get("opacity");
  const sc = [get("scale_0"), get("scale_1"), get("scale_2")];
  const rot = [get("rot_0"), get("rot_1"), get("rot_2"), get("rot_3")];
  const cloud = createCloud(count);
  cloud.worldScale = worldScale;
  cloud.worldUnit = worldUnit;
  cloud.antialiased = antialiased;
  const p = cloud.params;
  for (let i = 0; i < count; i++) {
    const b = i * PARAM_STRIDE;
    p[b] = x(i);
    p[b + 1] = y(i);
    p[b + 2] = z(i);
    for (let k = 0; k < 3; k++) {
      p[b + P_SCALE + k] = sc[k] ? sc[k]!(i) : Math.log(0.002);
    }
    if (rot[0]) {
      for (let k = 0; k < 4; k++) p[b + P_QUAT + k] = rot[k]!(i);
    } else {
      p[b + P_QUAT] = 1;
    }
    for (let k = 0; k < 3; k++) {
      let c: number;
      if (dc[k]) c = 0.5 + SH_C0 * dc[k]!(i);
      else if (rgb[k]) c = rgb[k]!(i) / 255;
      else c = 1;
      p[b + P_COLOR + k] = colorParam(c);
    }
    p[b + P_OPACITY] = op ? op(i) : logit(0.9);
  }
  return cloud;
}
