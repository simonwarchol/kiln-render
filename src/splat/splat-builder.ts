/**
 * Volume → Gaussian splats, end to end:
 *
 *  1. fit     — moment-matched Gaussians straight from the voxels, classified
 *               with the viewer's current channel colours / windows / TF /
 *               density / clip box (volume-fit.ts, in a worker);
 *  2. capture — render training views of the *same* volume with Kiln's DVR
 *               (transparent background, premultiplied RGBA) into a GPU
 *               texture array — no PNG round trip;
 *  3. train   — photometric refinement of the fitted Gaussians against those
 *               views on the GPU (rasterizer + backward + Adam, with
 *               densification and pruning).
 */

import type { Camera } from "../core/camera.js";
import { clipToWorld, type DatasetConfig } from "../core/config.js";
import type { Renderer } from "../core/renderer.js";
import type { TransferFunction } from "../core/transfer-function.js";
import type { DataProvider, VolumeMetadata } from "../data/data-provider.js";
import type { StreamingManager } from "../streaming/streaming-manager.js";
import { getFloat16ToFloat32Lut } from "../utils/float16.js";
import { cloudFromParams, type GaussianCloud } from "./cloud.js";
import { P_OPACITY, PARAM_STRIDE, sigmoid } from "./cpu-reference.js";
import { createBuffer, readBuffer, STORAGE_RW } from "./gpu/kernel.js";
import type { SplatBlend, SplatCamera } from "./gpu/rasterizer.js";
import { SplatRasterizer } from "./gpu/rasterizer.js";
import { densify, GpuGaussians, SplatTrainStep } from "./gpu/trainer.js";
import { splatCameraFor } from "./splat-layer.js";
import type { ClassifyParams } from "./volume-fit.js";
import { VolumeFitter } from "./volume-fit.js";
import type {
  FitWorkerRequest,
  FitWorkerResponse,
} from "./volume-fit-worker.js";
import FitWorkerInline from "./volume-fit-worker.ts?worker&inline";

export type BuildStage = "fit" | "capture" | "train" | "done";

/** Log to the console and to `window.__kilnLog` (handy when devtools are closed). */
export function debugLog(msg: string): void {
  console.log(`[Kiln] ${msg}`);
  const g = globalThis as unknown as { __kilnLog?: string[] };
  g.__kilnLog ??= [];
  g.__kilnLog.push(`${Math.round(performance.now())} ${msg}`);
  if (g.__kilnLog.length > 500) g.__kilnLog.shift();
}

export interface BuildProgress {
  stage: BuildStage;
  /** 0–1 within the stage */
  fraction: number;
  label: string;
  gaussians?: number;
  loss?: number;
  /** Mean PSNR (dB) of the splats vs. the volume on held-out views */
  psnr?: number;
}

export interface SplatBuildOptions {
  /** Gaussians produced by the fit (training may densify up to 2×). Default 1M. */
  targetCount?: number;
  /** Refine photometrically against DVR renders. Default true. */
  train?: boolean;
  /** Training iterations (default 3000) */
  iterations?: number;
  /** Training views (default 96) */
  views?: number;
  /** Square training image size in pixels (default 640) */
  resolution?: number;
  /** TAA frames accumulated per captured view (default 16) */
  settleFrames?: number;
  /** Seed for training-view placement; set to get a different (held-out) set */
  viewSeed?: number;
  /** Held-out views to score the result on (PSNR vs. the volume); 0 = skip */
  evaluateViews?: number;
  /** Fit pyramid level (default: finest that fits the memory budget) */
  fitLod?: number;
  /** Fit memory budget in bytes (default 512 MB) */
  fitMemoryBytes?: number;
  /**
   * How splats combine: "max" for maximum-intensity projections, "alpha"
   * otherwise. `KilnViewer.generateSplats` picks it from the render mode.
   */
  blend?: SplatBlend;
  onProgress?: (p: BuildProgress) => void;
  /** Called during training with the live Gaussians (for preview). */
  onPreview?: (params: GPUBuffer, count: number) => void;
  signal?: AbortSignal;
}

/** Everything the builder needs from the viewer. */
export interface SplatBuildHost {
  device: GPUDevice;
  renderer: Renderer;
  camera: Camera;
  streaming: StreamingManager;
  provider: DataProvider;
  metadata: VolumeMetadata;
  config: DatasetConfig;
  transferFunction: TransferFunction;
  canvas: HTMLCanvasElement;
  /** Current swapchain texture view (live feedback during capture). */
  presentView(): GPUTextureView;
}

/**
 * Yield to the event loop without depending on requestAnimationFrame (which
 * stops entirely while the page is occluded, e.g. a hidden pane or tab
 * behind another window — long builds should keep going).
 */
function yieldTask(delayMs = 0): Promise<void> {
  if (delayMs > 0) return new Promise((r) => setTimeout(r, delayMs));
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(null);
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("Splat build cancelled", "AbortError");
}

function createFitWorker(): Worker {
  if (import.meta.env.DEV) {
    return new Worker(new URL("./volume-fit-worker.ts", import.meta.url), {
      type: "module",
    });
  }
  return new FitWorkerInline();
}

export function classifyParamsFor(host: SplatBuildHost): ClassifyParams {
  const r = host.renderer;
  const tf = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [cr, cg, cb, ca] = host.transferFunction.sampleRgba(i / 255);
    tf.set([cr, cg, cb, ca], i * 4);
  }
  return {
    numChannels: r.numChannels,
    channelColors: Array.from(r.channelColors),
    channelWindowCenter: Array.from(r.channelWindowCenter),
    channelWindowWidth: Array.from(r.channelWindowWidth),
    floatMin: r.floatMin,
    floatMax: r.floatMax,
    windowCenter: r.windowCenter,
    windowWidth: r.windowWidth,
    tf,
    densityScale: r.densityScale,
    maxDim0: Math.max(...host.config.dimensions),
    clipMin: Array.from(r.clipMin),
    clipMax: Array.from(r.clipMax),
  };
}

/** Finest LOD whose fit fits in the memory budget. */
export function chooseFitLod(metadata: VolumeMetadata, budget: number): number {
  for (const level of [...metadata.levels].sort((a, b) => a.lod - b.lod)) {
    if (VolumeFitter.estimateBytes(level.dimensions) <= budget)
      return level.lod;
  }
  return metadata.maxLod;
}

/** Physical size of one normalised unit (for PLY metadata). */
function worldScaleOf(metadata: VolumeMetadata): number {
  const s = metadata.voxelSpacing ?? [1, 1, 1];
  return Math.max(
    metadata.dimensions[0] * s[0],
    metadata.dimensions[1] * s[1],
    metadata.dimensions[2] * s[2],
  );
}

/** Small RPC wrapper around a fit worker. */
class FitWorker {
  readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: FitWorkerResponse) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.worker = createFitWorker();
    this.worker.onmessage = (e: MessageEvent<FitWorkerResponse>) => {
      const r = e.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.type === "error") p.reject(new Error(r.message));
      else p.resolve(r);
    };
  }

  call(
    msg: FitWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<FitWorkerResponse> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("terminated"));
  }
}

/** Stage 1: direct fit from bricks (classification parallelised over workers). */
export async function fitVolume(
  host: SplatBuildHost,
  opts: SplatBuildOptions = {},
): Promise<GaussianCloud> {
  const meta = host.metadata;
  const lod =
    opts.fitLod ?? chooseFitLod(meta, opts.fitMemoryBytes ?? 512 * 1024 * 1024);
  const level = meta.levels.find((l) => l.lod === lod)!;
  const onProgress = opts.onProgress ?? (() => {});
  const grid = {
    dims: level.dimensions,
    normalizedSize: host.config.normalizedSize,
  };
  const params = classifyParamsFor(host);
  const nWorkers = Math.max(
    1,
    Math.min(6, (navigator.hardwareConcurrency || 4) - 2),
  );
  const pool = Array.from({ length: nWorkers }, () => new FitWorker());
  try {
    await Promise.all(
      pool.map((w) => w.call({ type: "init", id: 0, grid, params })),
    );
    // The merged node array lives here; workers only produce per-brick blocks.
    const merged = new VolumeFitter(grid, params);
    // Only bricks overlapping the clip box (tiles are built one clip box at
    // a time; the fitter also clips per voxel).
    const [gx, gy, gz] = level.brickGrid;
    const clipMin = host.renderer.clipMin;
    const clipMax = host.renderer.clipMax;
    const span = (a: number, n: number) => [
      Math.max(0, Math.floor((clipMin[a] ?? 0) * n)),
      Math.min(n - 1, Math.ceil((clipMax[a] ?? 1) * n) - 1),
    ];
    const [x0, x1] = span(0, gx);
    const [y0, y1] = span(1, gy);
    const [z0, z1] = span(2, gz);
    const bricks: Array<[number, number, number]> = [];
    for (let z = z0!; z <= z1!; z++)
      for (let y = y0!; y <= y1!; y++)
        for (let x = x0!; x <= x1!; x++) bricks.push([x, y, z]);
    const nch = host.renderer.numChannels;
    const visible = Array.from({ length: nch }, (_, ch) =>
      nch === 1 ? true : (host.renderer.channelColors[ch * 4 + 3] ?? 0) > 0,
    );
    const threshold = host.config.emptyBrickThreshold;
    let done = 0;
    let next = 0;
    let rr = 0;
    const loader = async () => {
      while (next < bricks.length) {
        const [bx, by, bz] = bricks[next++]!;
        throwIfAborted(opts.signal);
        if (!(await host.provider.isBrickEmpty(lod, bx, by, bz, threshold))) {
          const results = await Promise.all(
            visible.map((v, ch) =>
              v
                ? host.provider.loadBrick(lod, bx, by, bz, ch, opts.signal)
                : null,
            ),
          );
          const channels = results.map((r) => (r ? r.data.slice() : null));
          const w = pool[rr++ % pool.length]!;
          const res = await w.call(
            { type: "classify", id: 0, bx, by, bz, channels },
            channels.flatMap((c) => (c ? [c.buffer as ArrayBuffer] : [])),
          );
          if (res.type === "block" && res.block) {
            merged.addBlock(bx, by, bz, res.block, res.occupied);
          }
        }
        done++;
        onProgress({
          stage: "fit",
          fraction: (0.9 * done) / bricks.length,
          label: `Reading LOD ${lod} bricks ${done}/${bricks.length}`,
        });
      }
    };
    await Promise.all(Array.from({ length: 12 }, loader));
    onProgress({ stage: "fit", fraction: 0.92, label: "Fitting Gaussians…" });
    const nodes = merged.takeNodes();
    const res = await pool[0]!.call(
      {
        type: "finish",
        id: 0,
        nodes,
        occupied: merged.occupiedVoxels,
        options: { targetCount: opts.targetCount ?? 1_000_000 },
      },
      [nodes.buffer],
    );
    if (res.type !== "done") throw new Error("fit worker returned no result");
    const cloud = cloudFromParams(res.params, res.count, {
      blend: opts.blend,
      worldScale: worldScaleOf(meta),
      worldUnit: "micron",
    });
    onProgress({
      stage: "fit",
      fraction: 1,
      label: `Fitted ${res.count.toLocaleString()} Gaussians from ${merged.occupiedVoxels.toLocaleString()} voxels (LOD ${lod})`,
      gaussians: res.count,
    });
    return cloud;
  } finally {
    for (const w of pool) w.terminate();
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Fibonacci directions on the unit sphere. */
export function sphereDirections(n: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    out.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r]);
  }
  return out;
}

/** Orbit angles (Kiln Camera convention) that place the eye along `dir`. */
export function orbitForDirection(
  dir: [number, number, number],
  upAxis: string,
): { rotX: number; rotY: number } {
  const sign = upAxis.startsWith("-") ? -1 : 1;
  const base = upAxis.replace("-", "");
  const lim = Math.PI / 2 - 0.02;
  const clampX = (v: number) => Math.max(-lim, Math.min(lim, v));
  const asin = (v: number) => Math.asin(Math.max(-1, Math.min(1, v)));
  if (base === "x")
    return {
      rotX: clampX(asin(dir[0] * sign)),
      rotY: Math.atan2(dir[2], dir[1]),
    };
  if (base === "z")
    return {
      rotX: clampX(asin(dir[2] * sign)),
      rotY: Math.atan2(dir[1], dir[0]),
    };
  return {
    rotX: clampX(asin(dir[1] * sign)),
    rotY: Math.atan2(dir[0], dir[2]),
  };
}

export async function waitForBricks(
  streaming: StreamingManager,
  camera: Camera,
  canvas: HTMLCanvasElement,
  timeoutMs = 120_000,
): Promise<void> {
  const t0 = performance.now();
  let idle = -1; // −1 until the first check
  streaming.forceUpdate(camera, canvas);
  while (performance.now() - t0 < timeoutMs) {
    streaming.update(camera, canvas);
    const s = streaming.getStats();
    // A stalled view (more bricks than the atlas holds) will not settle.
    const settled =
      (s.pendingCount === 0 || streaming.isStalled) && streaming.baseLodLoaded;
    // Already resident right after the forced update: nothing to wait for.
    if (settled && (idle === -1 || ++idle >= 3)) return;
    if (!settled) idle = 0;
    await yieldTask(16);
  }
}

/** Deterministic random rotation (row-major 3×3) from a seed. */
/** Deterministic uniform [0, 1) generator (LCG) — reproducible view layouts. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomRotation(seed: number): number[] {
  const r = lcg(seed);
  // Uniform random unit quaternion (Shoemake)
  const u1 = r();
  const u2 = r() * 2 * Math.PI;
  const u3 = r() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  const [x, y, z, w] = [
    a * Math.sin(u2),
    a * Math.cos(u2),
    b * Math.sin(u3),
    b * Math.cos(u3),
  ];
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}

export interface CapturedViews {
  texture: GPUTexture;
  cameras: SplatCamera[];
  width: number;
  height: number;
  /** radius of the bounding sphere the views were placed around */
  radius: number;
}

/** Stage 2: render training views with Kiln's renderer (state is restored). */
export async function captureViews(
  host: SplatBuildHost,
  opts: SplatBuildOptions = {},
): Promise<CapturedViews> {
  const n = Math.max(4, Math.min(256, opts.views ?? 96));
  const size = Math.max(64, opts.resolution ?? 640);
  const settle = Math.max(1, opts.settleFrames ?? 16);
  const onProgress = opts.onProgress ?? (() => {});
  const { renderer, camera, canvas, device } = host;

  const saved = {
    width: canvas.width,
    height: canvas.height,
    orbit: camera.getOrbitState(),
    bg: Float32Array.from(renderer.background),
    early: renderer.earlyExitAlpha,
    wire: renderer.showWireframe,
    axis: renderer.showAxis,
  };
  const { lo, hi } = clipToWorld(
    host.config.normalizedSize,
    renderer.clipMin,
    renderer.clipMax,
  );
  const center: [number, number, number] = [
    (lo[0]! + hi[0]!) / 2,
    (lo[1]! + hi[1]!) / 2,
    (lo[2]! + hi[2]!) / 2,
  ];
  const radius =
    0.5 * Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  const fov = Math.PI / 4;
  const outer = Math.min(9.5, (radius / Math.sin(fov / 2)) * 1.02);
  const inner = Math.max(radius * 1.05, outer * 0.55);
  // Three kinds of views: whole-volume orbit, a closer orbit, and close-up
  // "detail" views aimed at random points inside the volume — the latter are
  // what lets training recover full-resolution structure.
  const nMid = Math.floor(n * 0.3);
  const nDetail = Math.floor(n * 0.3);
  const seed = opts.viewSeed ?? 12345;
  // Held-out views (viewSeed set) use the same layout under a random rotation.
  const rot = opts.viewSeed === undefined ? null : randomRotation(seed);
  const turn = (d: [number, number, number]): [number, number, number] =>
    rot
      ? [
          rot[0]! * d[0] + rot[1]! * d[1] + rot[2]! * d[2],
          rot[3]! * d[0] + rot[4]! * d[1] + rot[5]! * d[2],
          rot[6]! * d[0] + rot[7]! * d[1] + rot[8]! * d[2],
        ]
      : d;
  const rand = lcg(seed);
  const shots: Array<{
    dir: [number, number, number];
    dist: number;
    target: [number, number, number];
  }> = [];
  for (const dir of sphereDirections(n - nMid - nDetail))
    shots.push({ dir: turn(dir), dist: outer, target: center });
  for (const dir of sphereDirections(nMid))
    shots.push({ dir: turn(dir), dist: inner, target: center });
  const detailDist = Math.max(0.12, outer * 0.32);
  const detailDirs = sphereDirections(nDetail);
  const detail: typeof shots = [];
  for (let i = 0; i < nDetail; i++) {
    const t: [number, number, number] = [
      lo[0]! + (0.15 + 0.7 * rand()) * (hi[0]! - lo[0]!),
      lo[1]! + (0.15 + 0.7 * rand()) * (hi[1]! - lo[1]!),
      lo[2]! + (0.15 + 0.7 * rand()) * (hi[2]! - lo[2]!),
    ];
    detail.push({
      dir: turn(detailDirs[(i * 7) % nDetail]!),
      dist: detailDist,
      target: t,
    });
  }
  // Visit close-ups in spatial (Morton) order so consecutive views reuse the
  // same full-resolution bricks instead of thrashing the caches.
  const morton = (t: [number, number, number]) => {
    let code = 0;
    const q = [0, 1, 2].map((a) =>
      Math.min(
        1023,
        Math.max(
          0,
          Math.floor(
            ((t[a]! - lo[a]!) / Math.max(1e-9, hi[a]! - lo[a]!)) * 1024,
          ),
        ),
      ),
    );
    for (let bit = 9; bit >= 0; bit--)
      for (let a = 0; a < 3; a++) code = code * 2 + ((q[a]! >> bit) & 1);
    return code;
  };
  detail.sort((a, b) => morton(a.target) - morton(b.target));
  shots.push(...detail);

  const texture = device.createTexture({
    label: "splat:train-targets",
    size: [size, size, n],
    format: "rgba16float",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC,
  });
  const cameras: SplatCamera[] = [];

  // Settle frames render offscreen: presenting dozens of frames per view to
  // the canvas outside requestAnimationFrame piles up swapchain textures when
  // the page isn't compositing (hidden tab/pane). Present once per view.
  const offscreen = device.createTexture({
    label: "splat:capture-offscreen",
    size: [size, size],
    format: navigator.gpu.getPreferredCanvasFormat(),
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const offscreenView = offscreen.createView();
  canvas.width = size;
  canvas.height = size;
  renderer.resize(size, size);
  renderer.prepareScale(1);
  renderer.activateScale(1);
  renderer.background.set([0, 0, 0, 0]);
  renderer.earlyExitAlpha = 0.995;
  renderer.showWireframe = false;
  renderer.showAxis = false;
  try {
    let index = 0;
    for (const shot of shots) {
      throwIfAborted(opts.signal);
      const { rotX, rotY } = orbitForDirection(shot.dir, camera.getUpAxis());
      camera.setOrbitState([
        rotX,
        rotY,
        shot.dist,
        shot.target[0],
        shot.target[1],
        shot.target[2],
      ]);
      renderer.resetAccumulation();
      renderer.render(offscreenView, camera);
      await waitForBricks(host.streaming, camera, canvas);
      renderer.resetAccumulation();
      for (let f = 0; f < settle; f++) {
        renderer.render(offscreenView, camera);
        if (f % 4 === 3) await yieldTask();
      }
      if (typeof document === "undefined" || !document.hidden) {
        renderer.render(host.presentView(), camera);
      }
      const enc = device.createCommandEncoder();
      renderer.copyResultTo(enc, texture, index);
      device.queue.submit([enc.finish()]);
      cameras.push(splatCameraFor(camera, size, size));
      index++;
      // Keep the CPU in step with the GPU: without this, submission runs far
      // ahead (16 settle frames per view) and progress reads "done" while
      // minutes of rendering are still queued.
      await device.queue.onSubmittedWorkDone();
      onProgress({
        stage: "capture",
        fraction: index / n,
        label: `Rendering training view ${index}/${n}`,
      });
    }
  } finally {
    offscreen.destroy();
    canvas.width = saved.width;
    canvas.height = saved.height;
    renderer.resize(saved.width, saved.height);
    renderer.prepareScale(1);
    renderer.activateScale(1);
    renderer.resetAccumulation();
    camera.setOrbitState(saved.orbit);
    renderer.background.set(saved.bg);
    renderer.earlyExitAlpha = saved.early;
    renderer.showWireframe = saved.wire;
    renderer.showAxis = saved.axis;
  }
  return { texture, cameras, width: size, height: size, radius };
}

// ---------------------------------------------------------------------------
// Train
// ---------------------------------------------------------------------------

/** Stage 3: photometric refinement on the GPU. */
export async function trainCloud(
  device: GPUDevice,
  init: GaussianCloud,
  views: CapturedViews,
  opts: SplatBuildOptions = {},
): Promise<GaussianCloud> {
  const iterations = Math.max(1, opts.iterations ?? 3000);
  const onProgress = opts.onProgress ?? (() => {});
  const extent = Math.max(1e-3, views.radius);
  const maxCount = Math.ceil((opts.targetCount ?? init.count) * 2);
  const gs = new GpuGaussians(device, init.params, init.count);
  const rasterizer = new SplatRasterizer(device);
  rasterizer.blend = opts.blend ?? init.blend ?? "alpha";
  const step = new SplatTrainStep(rasterizer, gs, views);
  const nViews = views.cameras.length;
  let order: number[] = [];
  const lerpLog = (a: number, b: number, t: number) =>
    Math.exp(Math.log(a) * (1 - t) + Math.log(b) * t);
  const densifyFrom = 300;
  const densifyUntil = Math.floor(iterations * 0.6);
  const densifyEvery = 300;
  let lastLoss = Number.NaN;
  let lossIts = 0;
  try {
    for (let it = 0; it < iterations; it++) {
      throwIfAborted(opts.signal);
      if (order.length === 0) {
        order = Array.from({ length: nViews }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
      }
      const view = order.pop()!;
      const t = it / Math.max(1, iterations - 1);
      const lrs = {
        mean: lerpLog(1.6e-4 * extent, 1.6e-6 * extent, t),
        scale: 5e-3,
        quat: 1e-3,
        color: 5e-3,
        opacity: 2.5e-2,
      };
      const enc = device.createCommandEncoder({ label: "splat:train-step" });
      step.encodeStep(enc, view, lrs);
      device.queue.submit([enc.finish()]);
      lossIts++;

      // Keep intersection buffers large enough (checked against the GPU total).
      if (it % 20 === 0) {
        const m = await rasterizer.intersectionTotal();
        if (rasterizer.reserveIntersections(m)) step.invalidate();
      }

      if (it >= densifyFrom && it <= densifyUntil && it % densifyEvery === 0) {
        const [params, stats] = await Promise.all([
          gs.download(),
          gs.downloadStats(),
        ]);
        const res = densify(params, stats, gs.count, {
          gradThreshold: 1e-7,
          fraction: 0.06,
          splitScale: 0.01 * extent,
          minOpacity: 0.005,
          maxScale: 0.15 * extent,
          maxCount,
        });
        gs.upload(res.params, res.count);
        step.invalidate();
        debugLog(
          `densify @${it}: +${res.cloned} cloned, +${res.split} split, −${res.pruned} pruned → ${res.count}`,
        );
      }

      if (it % 50 === 49 || it === iterations - 1) {
        const l = await step.takeLosses();
        lastLoss = l.l1 / lossIts;
        const ssim = l.ssim / lossIts;
        lossIts = 0;
        debugLog(
          `train it ${it + 1}: L1 ${lastLoss.toFixed(4)}, SSIM ${ssim.toFixed(4)}, ${gs.count} Gaussians`,
        );
        onProgress({
          stage: "train",
          fraction: (it + 1) / iterations,
          label: `Training ${it + 1}/${iterations} · loss ${lastLoss.toExponential(2)} · ${gs.count.toLocaleString()} Gaussians`,
          gaussians: gs.count,
          loss: lastLoss,
        });
        if (it % 200 === 199) opts.onPreview?.(gs.params, gs.count);
        await yieldTask();
      }
    }
    const params = await gs.download();
    // Drop Gaussians that ended up invisible.
    let keep = 0;
    for (let i = 0; i < gs.count; i++) {
      if (sigmoid(params[i * PARAM_STRIDE + P_OPACITY]!) >= 0.004) {
        if (keep !== i) {
          params.copyWithin(
            keep * PARAM_STRIDE,
            i * PARAM_STRIDE,
            (i + 1) * PARAM_STRIDE,
          );
        }
        keep++;
      }
    }
    return cloudFromParams(params.slice(0, keep * PARAM_STRIDE), keep, {
      blend: rasterizer.blend,
      worldScale: init.worldScale,
      worldUnit: init.worldUnit,
    });
  } finally {
    step.destroy();
    rasterizer.destroy();
    gs.destroy();
  }
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

/**
 * Mean PSNR (dB) of `params` rendered from each captured view against the
 * volume render, both composited over `background` as displayed.
 */
export async function evaluateCloud(
  device: GPUDevice,
  params: GPUBuffer,
  count: number,
  views: CapturedViews,
  background: ArrayLike<number>,
  blend: SplatBlend = "alpha",
): Promise<number> {
  const r = new SplatRasterizer(device);
  r.blend = blend;
  const { width: w, height: h } = views;
  const rowBytes = Math.ceil((w * 8) / 256) * 256;
  const staging = createBuffer(
    device,
    "splat:eval-target",
    rowBytes * h,
    STORAGE_RW,
  );
  const f16 = getFloat16ToFloat32Lut();
  const bg = [background[0] ?? 0, background[1] ?? 0, background[2] ?? 0];
  let psnrSum = 0;
  try {
    r.resize(w, h);
    r.setGaussians(params, count);
    for (let v = 0; v < views.cameras.length; v++) {
      const enc = device.createCommandEncoder();
      r.encodeForward(enc, views.cameras[v]!);
      enc.copyTextureToBuffer(
        { texture: views.texture, origin: [0, 0, v] },
        { buffer: staging, bytesPerRow: rowBytes },
        [w, h, 1],
      );
      device.queue.submit([enc.finish()]);
      const m = await r.intersectionTotal();
      if (r.reserveIntersections(m)) {
        v--;
        continue;
      }
      const img = new Float32Array(
        await readBuffer(device, r.image, 0, w * h * 16),
      );
      const tgt = new Uint16Array(
        await readBuffer(device, staging, 0, rowBytes * h),
      );
      let se = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const p = (y * w + x) * 4;
          const t = (y * rowBytes) / 2 + x * 4;
          const pa = img[p + 3]!;
          const ta = f16[tgt[t + 3]!]!;
          for (let c = 0; c < 3; c++) {
            const a = Math.min(1, img[p + c]! + bg[c]! * (1 - pa));
            const b = Math.min(1, f16[tgt[t + c]!]! + bg[c]! * (1 - ta));
            se += (a - b) * (a - b);
          }
        }
      const mse = se / (w * h * 3);
      psnrSum += 10 * Math.log10(1 / Math.max(1e-10, mse));
    }
  } finally {
    r.destroy();
    staging.destroy();
  }
  return psnrSum / views.cameras.length;
}
