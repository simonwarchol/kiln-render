/**
 * Tile-based Gaussian splat rasterizer (forward pass) on WebGPU.
 *
 * Pipeline per frame:
 *   project → depth radix sort → per-Gaussian tile counts → scan →
 *   emit (tile, gaussian) pairs in depth order → stable sort by tile →
 *   tile ranges → per-tile front-to-back compositing.
 *
 * Output is a storage buffer of premultiplied RGBA (one vec4 per pixel) plus a
 * per-pixel (final T, last contributor) buffer the backward pass needs.
 * Everything stays on the GPU; the intersection total is read back
 * asynchronously only to grow buffers.
 */

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
import { GpuRadixSort } from "./radix-sort.js";
import {
  CAMERA_UNIFORM_SIZE,
  PROJ_STRIDE,
  PROJECT_WGSL,
  RANGES_WGSL,
  RASTERIZE_MAX_WGSL,
  RASTERIZE_WGSL,
  TILE,
  TILES_WGSL,
} from "./raster-wgsl.js";
import { GpuScan } from "./scan.js";

export interface SplatCamera {
  /** Column-major view matrix */
  view: ArrayLike<number>;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

interface RasterKernels {
  project: Kernel;
  countTiles: Kernel;
  emit: Kernel;
  rangesSetup: Kernel;
  ranges: Kernel;
  rasterize: Kernel;
  rasterizeMax: Kernel;
}

/**
 * How Gaussians combine per pixel: `alpha` = front-to-back compositing (3DGS,
 * matches DVR / isosurface renders); `max` = largest single contribution per
 * channel (matches maximum-intensity projection).
 */
export type SplatBlend = "alpha" | "max";

const kernelCache = new WeakMap<GPUDevice, RasterKernels>();

/** Minimum interval between intersection-capacity readbacks (display). */
const CAPACITY_CHECK_MS = 500;

function rasterKernels(device: GPUDevice): RasterKernels {
  let k = kernelCache.get(device);
  if (k) return k;
  const tileBindings = [
    "uniform",
    "read-only-storage",
    "read-only-storage",
    "storage",
    "storage",
    "storage",
  ] as const;
  const rangeBindings = [
    "uniform",
    "read-only-storage",
    "read-only-storage",
    "storage",
    "storage",
  ] as const;
  k = {
    project: createKernel(device, "splat:project", PROJECT_WGSL, "project", [
      "uniform",
      "read-only-storage",
      "storage",
      "storage",
      "storage",
    ]),
    countTiles: createKernel(
      device,
      "splat:count",
      TILES_WGSL,
      "countTiles",
      tileBindings,
    ),
    emit: createKernel(
      device,
      "splat:emit",
      TILES_WGSL,
      "emitIntersections",
      tileBindings,
    ),
    rangesSetup: createKernel(
      device,
      "splat:ranges-setup",
      RANGES_WGSL,
      "rangesSetup",
      rangeBindings,
    ),
    ranges: createKernel(
      device,
      "splat:ranges",
      RANGES_WGSL,
      "tileRangesKernel",
      rangeBindings,
    ),
    rasterize: createKernel(
      device,
      "splat:rasterize",
      RASTERIZE_WGSL,
      "rasterize",
      [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "storage",
      ],
    ),
    rasterizeMax: createKernel(
      device,
      "splat:rasterize-max",
      RASTERIZE_MAX_WGSL,
      "rasterizeMax",
      [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "storage",
      ],
    ),
  };
  kernelCache.set(device, k);
  return k;
}

function bitsFor(n: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
}

export class SplatRasterizer {
  readonly device: GPUDevice;
  private readonly k: RasterKernels;

  // Per-Gaussian
  private gaussianCapacity = 0;
  private count = 0;
  private params: GPUBuffer | null = null;
  projected!: GPUBuffer;
  private depthKeys!: GPUBuffer;
  depthIdx!: GPUBuffer;
  private offsets!: GPUBuffer;
  private countBuf!: GPUBuffer;
  private depthSort!: GpuRadixSort;
  private scan!: GpuScan;

  // Per-intersection
  private isectCapacity = 0;
  private isectKeys!: GPUBuffer;
  isectVals!: GPUBuffer;
  private isectSort!: GpuRadixSort;

  // Per-pixel / per-tile
  width = 0;
  height = 0;
  tilesX = 0;
  tilesY = 0;
  image!: GPUBuffer;
  aux!: GPUBuffer;
  tileRanges!: GPUBuffer;
  readonly camera: GPUBuffer;
  private readonly rangesIndirect: GPUBuffer;
  private readonly dummy: GPUBuffer;
  private readonly cameraScratch = new ArrayBuffer(CAMERA_UNIFORM_SIZE);

  private groups: Record<string, GPUBindGroup> | null = null;
  /** Multiplier applied to every Gaussian scale (display only). */
  scaleMul = 1;
  /**
   * Mip-Splatting opacity compensation for the screen-space dilation. On for
   * Kiln-trained clouds; off for ordinary 3DGS files trained without it.
   */
  mipFilter = true;
  /** Per-pixel combination; see {@link SplatBlend}. */
  blend: SplatBlend = "alpha";

  private readbackPending = false;
  private lastCapacityCheck = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.k = rasterKernels(device);
    this.camera = createBuffer(
      device,
      "splat:camera",
      CAMERA_UNIFORM_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.dummy = createBuffer(device, "splat:dummy", 16, STORAGE_RW);
    this.rangesIndirect = createBuffer(
      device,
      "splat:ranges-indirect",
      12,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
    );
  }

  get gaussianCount(): number {
    return this.count;
  }

  /** Point the rasterizer at a params buffer (PARAM_STRIDE floats per Gaussian). */
  setGaussians(params: GPUBuffer, count: number): void {
    // Bind groups only depend on buffers, not on the count (a uniform).
    if (params !== this.params) this.groups = null;
    this.params = params;
    this.count = count;
    if (count > this.gaussianCapacity) {
      this.allocGaussians(Math.max(count, 1024));
    }
    this.ensureIsectCapacity(Math.max(1 << 20, count * 8));
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.tilesX = Math.ceil(width / TILE);
    this.tilesY = Math.ceil(height / TILE);
    this.image?.destroy();
    this.aux?.destroy();
    this.tileRanges?.destroy();
    this.image = createBuffer(
      this.device,
      "splat:image",
      width * height * 16,
      STORAGE_RW,
    );
    // Alpha blend keeps (T, last) per pixel; max blend the 4 winners.
    this.aux = createBuffer(
      this.device,
      "splat:aux",
      width * height * 16,
      STORAGE_RW,
    );
    this.tileRanges = createBuffer(
      this.device,
      "splat:tile-ranges",
      this.tilesX * this.tilesY * 8,
      STORAGE_RW,
    );
    this.groups = null;
  }

  private allocGaussians(capacity: number): void {
    this.groups = null;
    this.gaussianCapacity = capacity;
    for (const b of [
      this.projected,
      this.depthKeys,
      this.depthIdx,
      this.offsets,
      this.countBuf,
    ])
      b?.destroy();
    this.depthSort?.destroy();
    this.scan?.destroy();
    const d = this.device;
    this.projected = createBuffer(
      d,
      "splat:projected",
      capacity * PROJ_STRIDE * 4,
      STORAGE_RW,
    );
    this.depthKeys = createBuffer(
      d,
      "splat:depth-keys",
      capacity * 4,
      STORAGE_RW,
    );
    this.depthIdx = createBuffer(
      d,
      "splat:depth-idx",
      capacity * 4,
      STORAGE_RW,
    );
    this.offsets = createBuffer(
      d,
      "splat:offsets",
      (capacity + 1) * 4,
      STORAGE_RW,
    );
    this.countBuf = createBuffer(d, "splat:count", 16, STORAGE_RW);
    this.depthSort = new GpuRadixSort(d, capacity);
    this.scan = new GpuScan(d, capacity + 1);
  }

  private ensureIsectCapacity(capacity: number): void {
    if (capacity <= this.isectCapacity) return;
    this.isectCapacity = capacity;
    this.isectKeys?.destroy();
    this.isectVals?.destroy();
    this.isectSort?.destroy();
    this.isectKeys = createBuffer(
      this.device,
      "splat:isect-keys",
      capacity * 4,
      STORAGE_RW,
    );
    this.isectVals = createBuffer(
      this.device,
      "splat:isect-vals",
      capacity * 4,
      STORAGE_RW,
    );
    this.isectSort = new GpuRadixSort(this.device, capacity);
    this.groups = null;
  }

  private writeCamera(cam: SplatCamera): void {
    const f = new Float32Array(this.cameraScratch);
    const u = new Uint32Array(this.cameraScratch);
    for (let i = 0; i < 16; i++) f[i] = cam.view[i]!;
    f[16] = cam.fx;
    f[17] = cam.fy;
    f[18] = cam.cx;
    f[19] = cam.cy;
    u[20] = this.width;
    u[21] = this.height;
    u[22] = this.tilesX;
    u[23] = this.tilesY;
    u[24] = this.count;
    u[25] = this.isectCapacity;
    f[26] = this.scaleMul;
    u[27] = this.mipFilter ? 1 : 0;
    this.device.queue.writeBuffer(this.camera, 0, this.cameraScratch);
    this.device.queue.writeBuffer(
      this.countBuf,
      0,
      new Uint32Array([this.count, this.count + 1, 0, 0]),
    );
  }

  private bindGroups(): Record<string, GPUBindGroup> {
    if (this.groups) return this.groups;
    const d = this.device;
    const k = this.k;
    if (!this.params) throw new Error("SplatRasterizer: no Gaussians set");
    this.groups = {
      project: bindGroup(d, k.project, [
        this.camera,
        this.params,
        this.projected,
        this.depthKeys,
        this.depthIdx,
      ]),
      tiles: bindGroup(d, k.countTiles, [
        this.camera,
        this.projected,
        this.depthIdx,
        this.offsets,
        this.isectKeys,
        this.isectVals,
      ]),
      emit: bindGroup(d, k.emit, [
        this.camera,
        this.projected,
        this.depthIdx,
        this.offsets,
        this.isectKeys,
        this.isectVals,
      ]),
      rangesSetup: bindGroup(d, k.rangesSetup, [
        this.camera,
        this.offsets,
        this.isectKeys,
        this.tileRanges,
        this.rangesIndirect,
      ]),
      // The indirect buffer can't be bound while it drives this dispatch.
      ranges: bindGroup(d, k.ranges, [
        this.camera,
        this.offsets,
        this.isectKeys,
        this.tileRanges,
        this.dummy,
      ]),
      rasterize: bindGroup(d, k.rasterize, [
        this.camera,
        this.projected,
        this.isectVals,
        this.tileRanges,
        this.image,
        this.aux,
      ]),
      rasterizeMax: bindGroup(d, k.rasterizeMax, [
        this.camera,
        this.projected,
        this.isectVals,
        this.tileRanges,
        this.image,
        this.aux,
      ]),
    };
    return this.groups;
  }

  /** Encode the full forward pass. Output lands in `image` / `aux`. */
  encodeForward(
    encoder: GPUCommandEncoder,
    cam: SplatCamera,
    profiler?: GpuProfiler,
  ): void {
    if (!this.params || this.width === 0) return;
    this.writeCamera(cam);
    const g = this.bindGroups();
    const k = this.k;
    const n = this.count;
    encoder.clearBuffer(this.tileRanges);
    if (n === 0) {
      encoder.clearBuffer(this.image);
      return;
    }
    const chain = new PassChain(encoder, "splat:forward", profiler);
    dispatch1d(
      chain.stage("project"),
      k.project,
      g.project!,
      Math.ceil(n / 256),
    );
    this.depthSort.encode(
      chain.stage("depth sort"),
      this.depthKeys,
      this.depthIdx,
      { buffer: this.countBuf, index: 0 },
      32,
    );
    dispatch1d(
      chain.stage("count tiles"),
      k.countTiles,
      g.tiles!,
      Math.ceil((n + 1) / 256),
    );
    this.scan.encode(chain.stage("scan"), this.offsets, {
      buffer: this.countBuf,
      index: 1,
    });
    dispatch1d(chain.stage("emit"), k.emit, g.emit!, Math.ceil(n / 256));
    this.isectSort.encode(
      chain.stage("tile sort"),
      this.isectKeys,
      this.isectVals,
      { buffer: this.offsets, index: n },
      bitsFor(this.tilesX * this.tilesY),
    );
    let pass = chain.stage("ranges");
    pass.setPipeline(k.rangesSetup.pipeline);
    pass.setBindGroup(0, g.rangesSetup!);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(k.ranges.pipeline);
    pass.setBindGroup(0, g.ranges!);
    pass.dispatchWorkgroupsIndirect(this.rangesIndirect, 0);
    pass = chain.stage("rasterize");
    const max = this.blend === "max";
    pass.setPipeline((max ? k.rasterizeMax : k.rasterize).pipeline);
    pass.setBindGroup(0, (max ? g.rasterizeMax : g.rasterize)!);
    pass.dispatchWorkgroups(this.tilesX, this.tilesY, 1);
    chain.end();
  }

  /**
   * After submitting a forward pass: read the intersection total back
   * asynchronously and grow buffers when close to capacity.
   */
  checkCapacity(): void {
    const now = performance.now();
    if (this.readbackPending || this.count === 0) return;
    // Capacity drifts slowly; a readback per displayed frame isn't needed.
    if (now - this.lastCapacityCheck < CAPACITY_CHECK_MS) return;
    this.lastCapacityCheck = now;
    this.readbackPending = true;
    const n = this.count;
    readBuffer(this.device, this.offsets, n * 4, 4)
      .then((buf) => {
        const m = new Uint32Array(buf)[0] ?? 0;
        if (m > this.isectCapacity * 0.85) {
          this.ensureIsectCapacity(Math.ceil(m * 1.5));
        }
      })
      .catch(() => {})
      .finally(() => {
        this.readbackPending = false;
      });
  }

  /** Synchronous-ish variant for training: await the true total. */
  async intersectionTotal(): Promise<number> {
    const buf = await readBuffer(this.device, this.offsets, this.count * 4, 4);
    return new Uint32Array(buf)[0] ?? 0;
  }

  /** Grow intersection buffers for at least `m` entries. Returns true if grown. */
  reserveIntersections(m: number): boolean {
    if (m <= this.isectCapacity) return false;
    this.ensureIsectCapacity(Math.ceil(m * 1.3));
    return true;
  }

  get intersectionCapacity(): number {
    return this.isectCapacity;
  }

  destroy(): void {
    for (const b of [
      this.projected,
      this.depthKeys,
      this.depthIdx,
      this.offsets,
      this.countBuf,
      this.isectKeys,
      this.isectVals,
      this.image,
      this.aux,
      this.tileRanges,
      this.camera,
      this.rangesIndirect,
      this.dummy,
    ])
      b?.destroy();
    this.depthSort?.destroy();
    this.isectSort?.destroy();
    this.scan?.destroy();
  }
}
