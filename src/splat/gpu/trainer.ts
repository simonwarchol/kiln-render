/**
 * GPU Gaussian splat optimiser: renders a training view with the forward
 * rasterizer, compares it against a target image (premultiplied RGBA from
 * Kiln's volume renderer), backpropagates through the rasterizer and the
 * projection, and applies sparse Adam — all on the GPU.
 *
 * Densification / pruning happens on the CPU every few hundred steps by
 * reading parameters and gradient statistics back.
 */

import { P_OPACITY, P_SCALE, PARAM_STRIDE, sigmoid } from "../cpu-reference.js";
import {
  bindGroup,
  createBuffer,
  createKernel,
  dispatch1d,
  type GpuProfiler,
  type Kernel,
  PassChain,
  readBuffer,
  STORAGE_RW,
} from "./kernel.js";
import type { SplatCamera, SplatRasterizer } from "./rasterizer.js";
import { SsimLoss } from "./ssim.js";
import {
  ADAM_UNIFORM_SIZE,
  GRAD2D_STRIDE,
  LOSS_WGSL,
  PROJECT_BACKWARD_WGSL,
  RASTER_BACKWARD_MAX_WGSL,
  rasterBackwardWgsl,
  STATS_STRIDE,
  TRAIN_UNIFORM_SIZE,
} from "./train-wgsl.js";

interface TrainKernels {
  loss: Kernel;
  rasterBackward: Kernel;
  /** backward for max blend (MIP clouds) */
  rasterBackwardMax: Kernel;
  /** writes parameter gradients (tests / debugging) */
  projectBackward: Kernel;
  /** projection backward fused with sparse Adam (training) */
  projectBackwardAdam: Kernel;
}

const PROJECT_BACKWARD_BINDINGS = [
  "uniform",
  "storage",
  "read-only-storage",
  "storage",
  "uniform",
  "storage",
  "storage",
  "storage",
] as const;

const kernelCache = new WeakMap<GPUDevice, TrainKernels>();

function trainKernels(device: GPUDevice): TrainKernels {
  let k = kernelCache.get(device);
  if (k) return k;
  // The subgroup reduction keeps one shared slot per subgroup.
  const minSg =
    (device as GPUDevice & { adapterInfo?: { subgroupMinSize?: number } })
      .adapterInfo?.subgroupMinSize ?? 0;
  const maxSubgroups = minSg > 0 ? Math.ceil(256 / minSg) : 0;
  const subgroups =
    device.features.has("subgroups") && maxSubgroups > 0 && maxSubgroups <= 16;
  k = {
    loss: createKernel(device, "splat:loss", LOSS_WGSL, "loss", [
      "uniform",
      "read-only-storage",
      "texture-unfilterable-array",
      "storage",
      "storage",
    ]),
    rasterBackward: createKernel(
      device,
      "splat:raster-backward",
      rasterBackwardWgsl(subgroups, maxSubgroups),
      "rasterBackward",
      [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
      ],
    ),
    rasterBackwardMax: createKernel(
      device,
      "splat:raster-backward-max",
      RASTER_BACKWARD_MAX_WGSL,
      "rasterBackwardMax",
      [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
      ],
    ),
    projectBackward: createKernel(
      device,
      "splat:project-backward",
      PROJECT_BACKWARD_WGSL,
      "projectBackward",
      PROJECT_BACKWARD_BINDINGS,
    ),
    projectBackwardAdam: createKernel(
      device,
      "splat:project-backward-adam",
      PROJECT_BACKWARD_WGSL,
      "projectBackwardAdam",
      PROJECT_BACKWARD_BINDINGS,
    ),
  };
  kernelCache.set(device, k);
  return k;
}

/** Learning rates (per step) for each parameter group. */
export interface LearningRates {
  mean: number;
  scale: number;
  quat: number;
  color: number;
  opacity: number;
}

/** Optimisable Gaussian parameters + Adam state on the GPU. */
export class GpuGaussians {
  readonly device: GPUDevice;
  capacity = 0;
  count = 0;
  params!: GPUBuffer;
  m1!: GPUBuffer;
  m2!: GPUBuffer;
  grad2D!: GPUBuffer;
  stats!: GPUBuffer;

  constructor(device: GPUDevice, data: Float32Array, count: number) {
    this.device = device;
    this.upload(data, count);
  }

  /** Replace all parameters (resets optimiser state). */
  upload(data: Float32Array, count: number): void {
    if (count > this.capacity) this.alloc(Math.ceil(count * 1.25) + 1024);
    this.count = count;
    this.device.queue.writeBuffer(
      this.params,
      0,
      data.buffer,
      data.byteOffset,
      count * PARAM_STRIDE * 4,
    );
    this.resetOptimizer();
  }

  resetOptimizer(): void {
    const enc = this.device.createCommandEncoder();
    enc.clearBuffer(this.m1);
    enc.clearBuffer(this.m2);
    enc.clearBuffer(this.stats);
    this.device.queue.submit([enc.finish()]);
  }

  private gradsBuf: GPUBuffer | null = null;

  /** Per-parameter gradients — only written by the test/debug backward. */
  get grads(): GPUBuffer {
    this.gradsBuf ??= createBuffer(
      this.device,
      "gs:grads",
      this.capacity * PARAM_STRIDE * 4,
      STORAGE_RW,
    );
    return this.gradsBuf;
  }

  private alloc(capacity: number): void {
    this.gradsBuf?.destroy();
    this.gradsBuf = null;
    for (const b of [this.params, this.m1, this.m2, this.grad2D, this.stats])
      b?.destroy();
    this.capacity = capacity;
    const d = this.device;
    const bytes = capacity * PARAM_STRIDE * 4;
    this.params = createBuffer(d, "gs:params", bytes, STORAGE_RW);
    this.m1 = createBuffer(d, "gs:adam-m", bytes, STORAGE_RW);
    this.m2 = createBuffer(d, "gs:adam-v", bytes, STORAGE_RW);
    this.grad2D = createBuffer(
      d,
      "gs:grad2d",
      capacity * GRAD2D_STRIDE * 4,
      STORAGE_RW,
    );
    this.stats = createBuffer(
      d,
      "gs:stats",
      capacity * STATS_STRIDE * 4,
      STORAGE_RW,
    );
  }

  async download(): Promise<Float32Array> {
    const buf = await readBuffer(
      this.device,
      this.params,
      0,
      this.count * PARAM_STRIDE * 4,
    );
    return new Float32Array(buf);
  }

  async downloadStats(): Promise<Float32Array> {
    const buf = await readBuffer(
      this.device,
      this.stats,
      0,
      this.count * STATS_STRIDE * 4,
    );
    return new Float32Array(buf);
  }

  destroy(): void {
    this.gradsBuf?.destroy();
    for (const b of [this.params, this.m1, this.m2, this.grad2D, this.stats])
      b?.destroy();
  }
}

/** Target images and cameras for training. */
export interface TrainingViews {
  /** rgba16float / rgba32float 2D-array texture, premultiplied, no background */
  texture: GPUTexture;
  cameras: SplatCamera[];
  width: number;
  height: number;
}

export class SplatTrainStep {
  readonly device: GPUDevice;
  private readonly k: TrainKernels;
  private readonly trainUniform: GPUBuffer;
  private readonly adamUniform: GPUBuffer;
  readonly dImage: GPUBuffer;
  readonly lossAccum: GPUBuffer;
  private readonly dummy: GPUBuffer;
  private groups: Record<string, GPUBindGroup> | null = null;
  private groupKey = "";
  private adamStep = 0;
  l1Weight = 0.8;
  /** Weight of the D-SSIM term (3DGS uses 0.2); 0 disables it. */
  ssimWeight = 0.2;
  alphaWeight = 1;
  private readonly ssim: SsimLoss;
  maxLogScale = Math.log(0.25);
  minLogScale = Math.log(1e-5);

  constructor(
    readonly rasterizer: SplatRasterizer,
    readonly gaussians: GpuGaussians,
    readonly views: TrainingViews,
  ) {
    this.device = rasterizer.device;
    this.k = trainKernels(this.device);
    this.trainUniform = createBuffer(
      this.device,
      "train:uniform",
      TRAIN_UNIFORM_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.adamUniform = createBuffer(
      this.device,
      "train:adam",
      ADAM_UNIFORM_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.dImage = createBuffer(
      this.device,
      "train:dimage",
      views.width * views.height * 16,
      STORAGE_RW,
    );
    this.lossAccum = createBuffer(this.device, "train:loss", 16, STORAGE_RW);
    this.dummy = createBuffer(this.device, "train:dummy", 16, STORAGE_RW);
    rasterizer.resize(views.width, views.height);
    this.ssim = new SsimLoss(
      this.device,
      views.width,
      views.height,
      views.texture,
      this.dImage,
      this.lossAccum,
    );
  }

  /** Call after Gaussians were reallocated/replaced. */
  invalidate(): void {
    this.groups = null;
    this.adamStep = 0;
  }

  private bindGroups(): Record<string, GPUBindGroup> {
    const r = this.rasterizer;
    const gs = this.gaussians;
    const key = [
      gs.params.label,
      gs.capacity,
      r.intersectionCapacity,
      r.width,
      r.height,
    ].join(":");
    if (this.groups && key === this.groupKey) return this.groups;
    const d = this.device;
    const k = this.k;
    this.groups = {
      loss: bindGroup(d, k.loss, [
        this.trainUniform,
        r.image,
        this.views.texture.createView({ dimension: "2d-array" }),
        this.dImage,
        this.lossAccum,
      ]),
      rasterBackward: bindGroup(d, k.rasterBackward, [
        r.camera,
        r.projected,
        r.isectVals,
        r.tileRanges,
        r.aux,
        this.dImage,
        gs.grad2D,
      ]),
      rasterBackwardMax: bindGroup(d, k.rasterBackwardMax, [
        r.camera,
        r.projected,
        r.aux,
        this.dImage,
        gs.grad2D,
      ]),
      projectBackwardAdam: bindGroup(d, k.projectBackwardAdam, [
        r.camera,
        gs.params,
        gs.grad2D,
        gs.stats,
        this.adamUniform,
        gs.m1,
        gs.m2,
        this.dummy,
      ]),
    };
    this.groupKey = key;
    return this.groups;
  }

  /** dL/dimage → per-Gaussian 2D gradients, for the rasterizer's blend. */
  private encodeRasterBackward(
    pass: GPUComputePassEncoder,
    g: Record<string, GPUBindGroup>,
  ): void {
    const r = this.rasterizer;
    const max = r.blend === "max";
    pass.setPipeline(
      (max ? this.k.rasterBackwardMax : this.k.rasterBackward).pipeline,
    );
    pass.setBindGroup(0, (max ? g.rasterBackwardMax : g.rasterBackward)!);
    pass.dispatchWorkgroups(r.tilesX, r.tilesY, 1);
  }

  /**
   * Encode backward from an externally provided dL/dimage into
   * `gaussians.grads` without updating parameters (testing).
   */
  encodeBackwardOnly(encoder: GPUCommandEncoder): void {
    const g = this.bindGroups();
    const r = this.rasterizer;
    const gs = this.gaussians;
    const gradsGroup = bindGroup(this.device, this.k.projectBackward, [
      r.camera,
      gs.params,
      gs.grad2D,
      gs.stats,
      this.adamUniform,
      gs.m1,
      gs.m2,
      gs.grads,
    ]);
    encoder.clearBuffer(this.gaussians.grad2D);
    const pass = encoder.beginComputePass({ label: "splat:backward" });
    this.encodeRasterBackward(pass, g);
    dispatch1d(
      pass,
      this.k.projectBackward,
      gradsGroup,
      Math.ceil(gs.count / 256),
    );
    pass.end();
  }

  /**
   * One optimisation step on `viewIndex`. `lrs` are this step's learning
   * rates. Returns nothing — read `lossAccum` occasionally for monitoring.
   */
  encodeStep(
    encoder: GPUCommandEncoder,
    viewIndex: number,
    lrs: LearningRates,
    profiler?: GpuProfiler,
  ): void {
    const r = this.rasterizer;
    const gs = this.gaussians;
    const views = this.views;
    r.setGaussians(gs.params, gs.count);
    const cam = views.cameras[viewIndex]!;
    r.encodeForward(encoder, cam, profiler);

    const tu = new ArrayBuffer(TRAIN_UNIFORM_SIZE);
    const u32 = new Uint32Array(tu);
    const f32 = new Float32Array(tu);
    u32[0] = views.width;
    u32[1] = views.height;
    u32[2] = viewIndex;
    f32[4] = this.l1Weight;
    f32[6] = this.alphaWeight;
    f32[7] = 1 / (views.width * views.height);
    this.device.queue.writeBuffer(this.trainUniform, 0, tu);

    this.adamStep++;
    const beta1 = 0.9;
    const beta2 = 0.999;
    const au = new ArrayBuffer(ADAM_UNIFORM_SIZE);
    const af = new Float32Array(au);
    const ai = new Uint32Array(au);
    af[0] = lrs.mean;
    af[1] = lrs.scale;
    af[2] = lrs.quat;
    af[3] = lrs.color;
    af[4] = lrs.opacity;
    af[5] = beta1;
    af[6] = beta2;
    af[7] = 1e-15;
    af[8] = 1 - beta1 ** this.adamStep;
    af[9] = 1 - beta2 ** this.adamStep;
    ai[10] = gs.count;
    af[11] = this.maxLogScale;
    af[12] = this.minLogScale;
    this.device.queue.writeBuffer(this.adamUniform, 0, au);

    const g = this.bindGroups();
    encoder.clearBuffer(gs.grad2D, 0, gs.count * GRAD2D_STRIDE * 4);
    const chain = new PassChain(encoder, "splat:train", profiler);
    const pass = chain.stage("loss");
    pass.setPipeline(this.k.loss.pipeline);
    pass.setBindGroup(0, g.loss!);
    pass.dispatchWorkgroups(
      Math.ceil(views.width / 16),
      Math.ceil(views.height / 16),
      1,
    );
    if (this.ssimWeight > 0) {
      this.ssim.encode(
        chain.stage("ssim"),
        r.image,
        viewIndex,
        this.ssimWeight,
      );
    }
    this.encodeRasterBackward(chain.stage("raster backward"), g);
    dispatch1d(
      chain.stage("project backward + adam"),
      this.k.projectBackwardAdam,
      g.projectBackwardAdam!,
      Math.ceil(gs.count / 256),
    );
    chain.end();
  }

  /**
   * Read and reset the accumulated losses since the last read:
   * `l1` = summed photometric term, `ssim` = summed mean SSIM.
   */
  async takeLosses(): Promise<{ l1: number; ssim: number }> {
    const v = new Float32Array(
      await readBuffer(this.device, this.lossAccum, 0, 8),
    );
    this.device.queue.writeBuffer(this.lossAccum, 0, new Float32Array([0, 0]));
    return { l1: v[0] ?? 0, ssim: v[1] ?? 0 };
  }

  /** Read and reset the accumulated photometric loss. */
  async takeLoss(): Promise<number> {
    return (await this.takeLosses()).l1;
  }

  destroy(): void {
    this.ssim.destroy();
    this.trainUniform.destroy();
    this.adamUniform.destroy();
    this.dImage.destroy();
    this.lossAccum.destroy();
    this.dummy.destroy();
  }
}

export interface DensifyOptions {
  /** Average screen-space gradient floor for cloning/splitting. */
  gradThreshold: number;
  /** Densify at most this fraction of Gaussians (highest gradients first). */
  fraction?: number;
  /** Scale (world units) separating clone (small) from split (large). */
  splitScale: number;
  /** Prune opacity below this. */
  minOpacity: number;
  /** Prune scales above this (world units). */
  maxScale: number;
  /** Hard cap on Gaussian count. */
  maxCount: number;
}

/**
 * CPU densification: clone small high-gradient Gaussians, split large ones,
 * prune transparent/huge ones. Returns new parameter array + count.
 */
export function densify(
  params: Float32Array,
  stats: Float32Array,
  count: number,
  opts: DensifyOptions,
  rand: () => number = Math.random,
): {
  params: Float32Array;
  count: number;
  cloned: number;
  split: number;
  pruned: number;
} {
  const keep: number[] = [];
  const clones: number[] = [];
  const splits: number[] = [];
  let pruned = 0;
  // Rank candidates so the cap keeps the strongest gradients.
  const candidates: Array<{ g: number; grad: number }> = [];
  for (let g = 0; g < count; g++) {
    const b = g * PARAM_STRIDE;
    const opacity = sigmoid(params[b + P_OPACITY]!);
    const maxS = Math.exp(
      Math.max(
        params[b + P_SCALE]!,
        params[b + P_SCALE + 1]!,
        params[b + P_SCALE + 2]!,
      ),
    );
    if (opacity < opts.minOpacity || maxS > opts.maxScale) {
      pruned++;
      continue;
    }
    keep.push(g);
    const n = stats[g * STATS_STRIDE + 1]!;
    const grad = n > 0 ? stats[g * STATS_STRIDE]! / n : 0;
    if (grad > opts.gradThreshold) candidates.push({ g, grad });
  }
  candidates.sort((a, b) => b.grad - a.grad);
  let budget = Math.max(0, opts.maxCount - keep.length);
  if (opts.fraction !== undefined) {
    budget = Math.min(budget, Math.floor(keep.length * opts.fraction));
  }
  for (const c of candidates) {
    if (budget <= 0) break;
    const b = c.g * PARAM_STRIDE;
    const maxS = Math.exp(
      Math.max(
        params[b + P_SCALE]!,
        params[b + P_SCALE + 1]!,
        params[b + P_SCALE + 2]!,
      ),
    );
    if (maxS > opts.splitScale) splits.push(c.g);
    else clones.push(c.g);
    budget--;
  }
  const splitSet = new Set(splits);
  const outCount = keep.length + clones.length + splits.length;
  const out = new Float32Array(outCount * PARAM_STRIDE);
  let o = 0;
  const copy = (g: number) => {
    out.set(
      params.subarray(g * PARAM_STRIDE, (g + 1) * PARAM_STRIDE),
      o * PARAM_STRIDE,
    );
    return o++;
  };
  const gauss = () => {
    // Box–Muller
    const u = Math.max(1e-9, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const splitInto = (g: number) => {
    const i = copy(g);
    const b = i * PARAM_STRIDE;
    const s = [
      Math.exp(out[b + 3]!),
      Math.exp(out[b + 4]!),
      Math.exp(out[b + 5]!),
    ];
    const w = out[b + 6]!;
    const x = out[b + 7]!;
    const y = out[b + 8]!;
    const z = out[b + 9]!;
    const n = Math.hypot(w, x, y, z) || 1;
    const qw = w / n;
    const qx = x / n;
    const qy = y / n;
    const qz = z / n;
    const R = [
      1 - 2 * (qy * qy + qz * qz),
      2 * (qx * qy - qw * qz),
      2 * (qx * qz + qw * qy),
      2 * (qx * qy + qw * qz),
      1 - 2 * (qx * qx + qz * qz),
      2 * (qy * qz - qw * qx),
      2 * (qx * qz - qw * qy),
      2 * (qy * qz + qw * qx),
      1 - 2 * (qx * qx + qy * qy),
    ];
    const l = [gauss() * s[0]!, gauss() * s[1]!, gauss() * s[2]!];
    for (let r = 0; r < 3; r++) {
      out[b + r] =
        out[b + r]! +
        R[r * 3]! * l[0]! +
        R[r * 3 + 1]! * l[1]! +
        R[r * 3 + 2]! * l[2]!;
    }
    for (let k = 0; k < 3; k++) out[b + 3 + k] = Math.log(s[k]! / 1.6);
  };
  for (const g of keep) {
    if (splitSet.has(g)) {
      splitInto(g);
      splitInto(g);
    } else {
      copy(g);
    }
  }
  for (const g of clones) copy(g);
  return {
    params: out,
    count: o,
    cloned: clones.length,
    split: splits.length,
    pruned,
  };
}
