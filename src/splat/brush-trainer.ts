/**
 * Photometric training with Brush (https://github.com/ArthurBrussee/brush),
 * via its WebAssembly bindings (vendor/brush-js).
 *
 * Brush trains from a Nerfstudio dataset in a directory, so the captured
 * views are written to the Origin Private File System as PNGs plus a
 * `transforms.json`, with the fitted cloud as the starting `init.ply`, and
 * the trained splats are read back out of Brush's GPU buffers.
 *
 * Brush trains on a GPUDevice of its own. Its kernels use subgroup builtins,
 * but CubeCL (its shader compiler) leaves out the `enable subgroups;`
 * directive browsers require, so Kiln adds it to such shaders.
 *
 * Kiln's camera (OpenGL axes, image y down) is the Nerfstudio convention, so
 * each frame's camera-to-world matrix is the inverse view matrix. Splats are
 * trained with SH degree 0 (Kiln renders the DC colour only) and Mip-Splatting
 * compensation, which Kiln's rasterizer applies to antialiased clouds.
 *
 * Brush stores targets as 8-bit straight-alpha RGBA, so a pixel can be no
 * brighter than its alpha; Kiln's additive multichannel DVR often is. Colour
 * enters the render linearly, so targets (and the starting cloud) are divided
 * by a gain that brings every pixel in range and the trained colours are
 * multiplied back.
 */

import type { BrushApp, Training } from "brush-js";
import { zlibSync } from "fflate";
import { mat4 } from "wgpu-matrix";
import { getFloat16ToFloat32Lut } from "../utils/float16.js";
import { cloudFromParams, type GaussianCloud, writePly } from "./cloud.js";
import {
  colorParam,
  P_COLOR,
  P_MEAN,
  P_OPACITY,
  P_QUAT,
  P_SCALE,
  PARAM_STRIDE,
} from "./cpu-reference.js";
import { createBuffer, readBuffer, STORAGE_RW } from "./gpu/kernel.js";
import type { SplatCamera } from "./gpu/rasterizer.js";

const SH_C0 = 0.28209479177387814;
const SUBGROUP_PRELUDE =
  "enable subgroups;\ndiagnostic(off, subgroup_uniformity);\n";
/** Training folders older than this are left over from a crashed tab. */
const STALE_RUN_MS = 6 * 3600 * 1000;
const OPFS_ROOT = "kiln-brush";
/** Floats per splat in Brush's transforms buffer: mean, quat wxyz, log scale. */
const TRANSFORM_STRIDE = 10;

export interface TrainViews {
  /** rgba16float array texture, premultiplied, one layer per view */
  texture: GPUTexture;
  cameras: SplatCamera[];
  width: number;
  height: number;
}

export interface BrushTrainOptions {
  iterations: number;
  /** Cap on splats after densification */
  maxSplats: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number, label: string, splats?: number) => void;
}

interface Brush {
  app: BrushApp;
  device: GPUDevice;
}

let brush: Promise<Brush> | null = null;
/** A Rust panic aborts the wasm instance; it can't be used again. */
let crashed = false;

/** Prepend `enable subgroups;` to shaders that use subgroup builtins. */
function addSubgroupDirective(device: GPUDevice): void {
  const createShaderModule = device.createShaderModule.bind(device);
  device.createShaderModule = (d) =>
    createShaderModule(
      /\bsubgroup[A-Z]/.test(d.code) && !/enable subgroups/.test(d.code)
        ? { ...d, code: `${SUBGROUP_PRELUDE}${d.code}` }
        : d,
    );
}

/**
 * Load the wasm and let Brush create its device. Brush keeps the GPUDevice
 * to itself, so `requestDevice` is wrapped while it initialises: Kiln needs
 * the device to read the trained splats back, and to patch its shaders.
 */
async function createBrush(): Promise<Brush> {
  const m = await import("brush-js");
  await m.default();
  const app = new m.BrushApp();
  const requestDevice = GPUAdapter.prototype.requestDevice;
  let device: GPUDevice | null = null;
  GPUAdapter.prototype.requestDevice = async function (desc) {
    const d = await requestDevice.call(this, desc);
    addSubgroupDirective(d);
    device = d;
    return d;
  };
  try {
    await app.init();
  } finally {
    GPUAdapter.prototype.requestDevice = requestDevice;
  }
  const created = device as GPUDevice | null;
  if (!created) throw new Error("Brush did not create a GPU device");
  void created.lost.then(() => {
    brush = null;
  });
  return { app, device: created };
}

/** Load the wasm and create Brush's device once. */
function brushRuntime(): Promise<Brush> {
  if (crashed)
    return Promise.reject(
      new Error("Brush crashed earlier; reload the page to train again"),
    );
  brush ??= createBrush().catch((e) => {
    brush = null;
    throw e;
  });
  return brush;
}

// ---------------------------------------------------------------------------
// PNG (straight-alpha RGBA8). A canvas would premultiply on the way and lose
// the faint alpha a volume render is mostly made of.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(rgba: Uint8Array, width: number, height: number) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    // Filter byte 0 (none) per row.
    raw.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibSync(raw, { level: 6 })),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Alpha below which a pixel's colour ratio is noise, not signal. */
const GAIN_MIN_ALPHA = 2 / 255;
const MAX_GAIN = 16;

/** Largest straight colour (premultiplied colour ÷ alpha) in a view. */
function maxStraight(
  half: Uint16Array,
  width: number,
  height: number,
  rowHalfs: number,
): number {
  const f16 = getFloat16ToFloat32Lut();
  let m = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const s = y * rowHalfs + x * 4;
      const a = f16[half[s + 3]!]!;
      if (a < GAIN_MIN_ALPHA) continue;
      const c = Math.max(
        f16[half[s]!]!,
        f16[half[s + 1]!]!,
        f16[half[s + 2]!]!,
      );
      if (c > m * a) m = c / a;
    }
  return m;
}

/** Premultiplied half-float RGBA (padded rows) ÷ gain → straight RGBA8. */
function toStraightRgba8(
  half: Uint16Array,
  width: number,
  height: number,
  rowHalfs: number,
  gain: number,
): Uint8Array {
  const f16 = getFloat16ToFloat32Lut();
  const out = new Uint8Array(width * height * 4);
  const to8 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const s = y * rowHalfs + x * 4;
      const d = (y * width + x) * 4;
      const a = f16[half[s + 3]!]!;
      const inv = a > 1e-6 ? 1 / (a * gain) : 0;
      out[d] = to8(f16[half[s]!]! * inv);
      out[d + 1] = to8(f16[half[s + 1]!]! * inv);
      out[d + 2] = to8(f16[half[s + 2]!]! * inv);
      out[d + 3] = to8(a);
    }
  return out;
}

/** Copy of `cloud` with colours multiplied by `gain` (colour = exp(param)). */
function scaleColours(cloud: GaussianCloud, gain: number): GaussianCloud {
  const params = cloud.params.slice();
  const d = Math.log(gain);
  for (let i = 0; i < cloud.count; i++)
    for (let k = 0; k < 3; k++) params[i * PARAM_STRIDE + P_COLOR + k]! += d;
  return { ...cloud, params };
}

/** Nerfstudio camera-to-world (row-major rows) from Kiln's view matrix. */
export function cameraToWorldRows(view: ArrayLike<number>): number[][] {
  const c2w = mat4.inverse(Float32Array.from(view)); // column-major
  return [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => c2w[c * 4 + r]!));
}

async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes as Uint8Array<ArrayBuffer>);
  await w.close();
}

/**
 * Write the views, cameras and starting cloud as a Nerfstudio dataset;
 * returns the colour gain the targets were divided by.
 */
async function writeDataset(
  device: GPUDevice,
  dir: FileSystemDirectoryHandle,
  init: GaussianCloud,
  views: TrainViews,
  opts: BrushTrainOptions,
): Promise<number> {
  const { width: w, height: h } = views;
  const images = await dir.getDirectoryHandle("images", { create: true });
  const rowBytes = Math.ceil((w * 8) / 256) * 256;
  const staging = createBuffer(device, "brush:view", rowBytes * h, STORAGE_RW);
  const readView = async (i: number) => {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: views.texture, origin: [0, 0, i] },
      { buffer: staging, bytesPerRow: rowBytes },
      [w, h, 1],
    );
    device.queue.submit([enc.finish()]);
    return new Uint16Array(await readBuffer(device, staging, 0, rowBytes * h));
  };
  const frames: Array<{ file_path: string; transform_matrix: number[][] }> = [];
  const n = views.cameras.length;
  let gain = 1;
  try {
    for (let i = 0; i < n; i++) {
      if (opts.signal?.aborted) throw abortError();
      gain = Math.max(gain, maxStraight(await readView(i), w, h, rowBytes / 2));
    }
    gain = Math.min(MAX_GAIN, gain);
    if (gain > 1)
      console.log(`[Kiln] Brush targets scaled by 1/${gain.toFixed(2)}`);
    for (const [i, cam] of views.cameras.entries()) {
      if (opts.signal?.aborted) throw abortError();
      const half = await readView(i);
      const name = `${String(i).padStart(4, "0")}.png`;
      await writeFile(
        images,
        name,
        encodePng(toStraightRgba8(half, w, h, rowBytes / 2, gain), w, h),
      );
      frames.push({
        file_path: `images/${name}`,
        transform_matrix: cameraToWorldRows(cam.view),
      });
      opts.onProgress?.(
        (0.1 * (i + 1)) / n,
        `Writing training view ${i + 1}/${n} for Brush`,
      );
    }
  } finally {
    staging.destroy();
  }
  const cam = views.cameras[0]!;
  const transforms = {
    w,
    h,
    fl_x: cam.fx,
    fl_y: cam.fy,
    cx: cam.cx,
    cy: cam.cy,
    ply_file_path: "init.ply",
    frames,
  };
  await writeFile(
    dir,
    "transforms.json",
    new TextEncoder().encode(JSON.stringify(transforms)),
  );
  await writeFile(dir, "init.ply", writePly(scaleColours(init, 1 / gain)));
  return gain;
}

function abortError(): DOMException {
  return new DOMException("Splat build cancelled", "AbortError");
}

/** Brush's splats → Kiln's parameter layout, colours × `gain`. */
async function readSplats(
  device: GPUDevice,
  training: Training,
  gain: number,
): Promise<{ params: Float32Array; count: number }> {
  const splats = training.currentSplats();
  if (!splats) throw new Error("Brush produced no splats");
  const n = splats.numSplats;
  const nCoeffs = (splats.shDegree + 1) ** 2;
  const buffers = splats.buffers();
  if (!buffers) throw new Error("Brush is not running on WebGPU");
  const [transforms, sh, opacity] = await Promise.all([
    readBuffer(device, buffers.transforms, 0, n * TRANSFORM_STRIDE * 4),
    readBuffer(device, buffers.shCoeffs, 0, n * nCoeffs * 3 * 4),
    readBuffer(device, buffers.rawOpacities, 0, n * 4),
  ]).then((bufs) => bufs.map((b) => new Float32Array(b)));
  buffers.free();
  splats.free();
  const params = new Float32Array(n * PARAM_STRIDE);
  for (let i = 0; i < n; i++) {
    const t = i * TRANSFORM_STRIDE;
    const b = i * PARAM_STRIDE;
    for (let k = 0; k < 3; k++) {
      params[b + P_MEAN + k] = transforms![t + k]!;
      params[b + P_SCALE + k] = transforms![t + 7 + k]!;
      params[b + P_COLOR + k] = colorParam(
        gain * (0.5 + SH_C0 * sh![i * nCoeffs * 3 + k]!),
      );
    }
    for (let k = 0; k < 4; k++)
      params[b + P_QUAT + k] = transforms![t + 3 + k]!;
    params[b + P_OPACITY] = opacity![i]!;
  }
  return { params, count: n };
}

/** Delete training folders a crashed or closed tab left behind. */
async function removeStaleRuns(root: FileSystemDirectoryHandle): Promise<void> {
  const listing = root as unknown as { keys(): AsyncIterable<string> };
  for await (const name of listing.keys()) {
    const started = Number.parseInt(name.split("-")[1] ?? "", 36);
    if (Number.isFinite(started) && Date.now() - started > STALE_RUN_MS)
      await root.removeEntry(name, { recursive: true }).catch(() => {});
  }
}

/**
 * Brush's config with `overrides` applied (keys are Brush's kebab-case
 * option names). Unknown keys would be dropped silently, so they warn.
 */
function withOverrides(
  config: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(overrides))
    if (!(key in config)) console.warn(`[Kiln] Brush has no option "${key}"`);
  return { ...config, ...overrides };
}

/**
 * Train `init` against `views` (textures on `device`) with Brush; returns
 * the trained cloud.
 */
export async function trainWithBrush(
  device: GPUDevice,
  init: GaussianCloud,
  views: TrainViews,
  opts: BrushTrainOptions,
): Promise<GaussianCloud> {
  const onProgress = opts.onProgress ?? (() => {});
  onProgress(0, "Loading Brush…");
  const { app, device: brushDevice } = await brushRuntime();
  const root = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(OPFS_ROOT, { create: true });
  await removeStaleRuns(root);
  const runName = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = await root.getDirectoryHandle(runName, { create: true });
  let training: Training | null = null;
  let removeListener = () => {};
  try {
    const gain = await writeDataset(device, dir, init, views, opts);
    const iterations = Math.max(1, Math.round(opts.iterations));
    training = app.startTrainingFromDirectory(
      dir,
      async (config: Record<string, unknown>) =>
        withOverrides(config, {
          "total-train-iters": iterations,
          // Kiln renders the DC colour with Mip-Splatting compensation.
          "sh-degree": 0,
          "render-mode": "mip",
          // Volume renders are see-through: train against their alpha.
          "alpha-mode": "transparent",
          "background-color": [0, 0, 0],
          "max-splats": opts.maxSplats,
          "max-resolution": Math.max(views.width, views.height),
          "growth-stop-iter": Math.min(
            Number(config["growth-stop-iter"] ?? iterations),
            Math.floor(iterations * 0.6),
          ),
          // Kiln scores the result on its own held-out views.
          "eval-split-every": null,
          "eval-every": iterations + 1,
          "export-every": iterations + 1,
        }),
    );
    // A failed kernel or a Rust panic never resolves trainSteps: fail on the
    // first GPU error or wasm trap instead.
    let fail: (e: Error) => void = () => {};
    const failed = new Promise<never>((_, reject) => {
      fail = reject;
    });
    failed.catch(() => {});
    const onGpuError = (e: Event) =>
      fail(
        new Error(
          `Brush GPU error: ${(e as GPUUncapturedErrorEvent).error.message}`,
        ),
      );
    const onTrap = (e: ErrorEvent | PromiseRejectionEvent) => {
      const err = "reason" in e ? e.reason : e.error;
      if (!(err instanceof WebAssembly.RuntimeError)) return;
      crashed = true;
      fail(new Error(`Brush crashed: ${err.message} (see the console)`));
    };
    brushDevice.addEventListener("uncapturederror", onGpuError);
    addEventListener("error", onTrap);
    addEventListener("unhandledrejection", onTrap);
    removeListener = () => {
      brushDevice.removeEventListener("uncapturederror", onGpuError);
      removeEventListener("error", onTrap);
      removeEventListener("unhandledrejection", onTrap);
    };
    const step = Math.max(1, Math.min(50, Math.floor(iterations / 100)));
    let iter = 0;
    let splats = init.count;
    for (;;) {
      if (opts.signal?.aborted) throw abortError();
      const msgs = await Promise.race([training.trainSteps(step), failed]);
      if (msgs.length === 0) break;
      for (const m of msgs) {
        if (m.iter !== undefined) iter = m.iter;
        if (m.numSplats !== undefined) splats = m.numSplats;
        if (m.text) console.warn(`[Kiln] Brush: ${m.text}`);
        m.free();
      }
      onProgress(
        0.1 + (0.9 * Math.min(iter, iterations)) / iterations,
        `Training with Brush ${Math.min(iter, iterations)}/${iterations} · ${splats.toLocaleString()} Gaussians`,
        splats,
      );
      if (iter >= iterations) break;
    }
    const { params, count } = await readSplats(brushDevice, training, gain);
    return cloudFromParams(params, count, {
      worldScale: init.worldScale,
      worldUnit: init.worldUnit,
    });
  } finally {
    removeListener();
    if (!crashed) training?.free();
    await root.removeEntry(runName, { recursive: true }).catch(() => {});
  }
}
