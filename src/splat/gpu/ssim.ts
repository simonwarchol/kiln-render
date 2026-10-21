/**
 * D-SSIM loss + gradient on the GPU (11-tap Gaussian window, σ = 1.5, zero
 * padding), applied to all four premultiplied RGBA channels.
 *
 * With μ = G∗x, P = G∗x², Pxy = G∗(xy) the per-pixel SSIM is
 *   S = (2μxμy + C1)(2(Pxy − μxμy) + C2) / ((μx² + μy² + C1)(Px − μx² + Py − μy² + C2))
 * and, for L = λ·(1 − mean S),
 *   ∂L/∂x_p = −λ/N · [ G∗(∂S/∂μx) + 2x_p·G∗(∂S/∂Px) + y_p·G∗(∂S/∂Pxy) ]_p
 * (G is symmetric, so correlation = convolution). Four separable passes:
 * blur-h of the 5 moments, blur-v + SSIM partials, blur-h of the partials,
 * blur-v + combine (accumulated into dImage).
 */

import {
  bindGroup,
  createBuffer,
  createKernel,
  type Kernel,
  readBuffer,
  STORAGE_RW,
  wgslAtomicAddF,
} from "./kernel.js";

const RADIUS = 5;
const SIGMA = 1.5;

function weights(): number[] {
  const w: number[] = [];
  let sum = 0;
  for (let i = -RADIUS; i <= RADIUS; i++) {
    const v = Math.exp(-(i * i) / (2 * SIGMA * SIGMA));
    w.push(v);
    sum += v;
  }
  return w.map((v) => v / sum);
}

const W = weights();

const COMMON = /* wgsl */ `
struct SsimParams {
  width: u32,
  height: u32,
  layer: u32,
  _pad: u32,
  lambda: f32,
  invPixels: f32,
  _p1: f32,
  _p2: f32,
}
@group(0) @binding(0) var<uniform> sp: SsimParams;

const RADIUS: i32 = ${RADIUS};
const WEIGHTS = array<f32, ${2 * RADIUS + 1}>(${W.map((v) => v.toFixed(9)).join(", ")});
const C1: f32 = 0.0001;
const C2: f32 = 0.0009;
`;

/** Pass 1 — horizontal blur of x, y, x², y², xy (vec4 each, RGBA). */
const PASS1 = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var<storage, read> image: array<vec4f>;
@group(0) @binding(2) var targets: texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read_write> h1: array<vec4f>;

@compute @workgroup_size(16, 16)
fn blurMomentsH(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= sp.width || gid.y >= sp.height) { return; }
  var mx = vec4f(0.0); var my = vec4f(0.0); var xx = vec4f(0.0); var yy = vec4f(0.0); var xy = vec4f(0.0);
  for (var k = -RADIUS; k <= RADIUS; k++) {
    let sx = i32(gid.x) + k;
    if (sx < 0 || sx >= i32(sp.width)) { continue; }
    let w = WEIGHTS[k + RADIUS];
    let x = image[gid.y * sp.width + u32(sx)];
    let y = textureLoad(targets, vec2i(sx, i32(gid.y)), i32(sp.layer), 0);
    mx += w * x; my += w * y; xx += w * x * x; yy += w * y * y; xy += w * x * y;
  }
  let o = (gid.y * sp.width + gid.x) * 5u;
  h1[o] = mx; h1[o + 1u] = my; h1[o + 2u] = xx; h1[o + 3u] = yy; h1[o + 4u] = xy;
}
`;

/** Pass 2 — vertical blur, SSIM and its partials (dS/dμx, dS/dPx, dS/dPxy). */
const PASS2 = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var<storage, read> h1: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> partials: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> lossAccum: array<atomic<u32>>;

var<workgroup> partialSum: array<f32, 256>;

${wgslAtomicAddF("atomicAddLoss", "lossAccum")}

@compute @workgroup_size(16, 16)
fn ssimPartials(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32) {
  var s = 0.0;
  if (gid.x < sp.width && gid.y < sp.height) {
    var mx = vec4f(0.0); var my = vec4f(0.0); var px = vec4f(0.0); var py = vec4f(0.0); var pxy = vec4f(0.0);
    for (var k = -RADIUS; k <= RADIUS; k++) {
      let sy = i32(gid.y) + k;
      if (sy < 0 || sy >= i32(sp.height)) { continue; }
      let w = WEIGHTS[k + RADIUS];
      let o = (u32(sy) * sp.width + gid.x) * 5u;
      mx += w * h1[o]; my += w * h1[o + 1u]; px += w * h1[o + 2u]; py += w * h1[o + 3u]; pxy += w * h1[o + 4u];
    }
    let a1 = 2.0 * mx * my + C1;
    let a2 = 2.0 * (pxy - mx * my) + C2;
    let b1 = mx * mx + my * my + C1;
    let b2 = (px - mx * mx) + (py - my * my) + C2;
    let S = (a1 * a2) / (b1 * b2);
    let dSdm = (2.0 * my * a2 - 2.0 * my * a1) / (b1 * b2) - S * (2.0 * mx / b1 - 2.0 * mx / b2);
    let dSdPx = -S / b2;
    let dSdPxy = 2.0 * a1 / (b1 * b2);
    let o = (gid.y * sp.width + gid.x) * 3u;
    partials[o] = dSdm; partials[o + 1u] = dSdPx; partials[o + 2u] = dSdPxy;
    s = dot(S, vec4f(0.25));
  }
  partialSum[lid] = s;
  workgroupBarrier();
  for (var st = 128u; st > 0u; st >>= 1u) {
    if (lid < st) { partialSum[lid] += partialSum[lid + st]; }
    workgroupBarrier();
  }
  if (lid == 0u) { atomicAddLoss(1u, partialSum[0] * sp.invPixels); }
}
`;

/** Pass 3 — horizontal blur of the partials. */
const PASS3 = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var<storage, read> partials: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> h2: array<vec4f>;

@compute @workgroup_size(16, 16)
fn blurPartialsH(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= sp.width || gid.y >= sp.height) { return; }
  var a = vec4f(0.0); var b = vec4f(0.0); var c = vec4f(0.0);
  for (var k = -RADIUS; k <= RADIUS; k++) {
    let sx = i32(gid.x) + k;
    if (sx < 0 || sx >= i32(sp.width)) { continue; }
    let w = WEIGHTS[k + RADIUS];
    let o = (gid.y * sp.width + u32(sx)) * 3u;
    a += w * partials[o]; b += w * partials[o + 1u]; c += w * partials[o + 2u];
  }
  let o = (gid.y * sp.width + gid.x) * 3u;
  h2[o] = a; h2[o + 1u] = b; h2[o + 2u] = c;
}
`;

/** Pass 4 — vertical blur + combine into dImage (accumulated). */
const PASS4 = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var<storage, read> h2: array<vec4f>;
@group(0) @binding(2) var<storage, read> image: array<vec4f>;
@group(0) @binding(3) var targets: texture_2d_array<f32>;
@group(0) @binding(4) var<storage, read_write> dImage: array<vec4f>;

@compute @workgroup_size(16, 16)
fn combine(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= sp.width || gid.y >= sp.height) { return; }
  var a = vec4f(0.0); var b = vec4f(0.0); var c = vec4f(0.0);
  for (var k = -RADIUS; k <= RADIUS; k++) {
    let sy = i32(gid.y) + k;
    if (sy < 0 || sy >= i32(sp.height)) { continue; }
    let w = WEIGHTS[k + RADIUS];
    let o = (u32(sy) * sp.width + gid.x) * 3u;
    a += w * h2[o]; b += w * h2[o + 1u]; c += w * h2[o + 2u];
  }
  let pix = gid.y * sp.width + gid.x;
  let x = image[pix];
  let y = textureLoad(targets, vec2i(gid.xy), i32(sp.layer), 0);
  // mean over 4 channels and N pixels
  let g = -sp.lambda * 0.25 * sp.invPixels * (a + 2.0 * x * b + y * c);
  dImage[pix] = dImage[pix] + g;
}
`;

interface SsimKernels {
  p1: Kernel;
  p2: Kernel;
  p3: Kernel;
  p4: Kernel;
}

const cache = new WeakMap<GPUDevice, SsimKernels>();

function kernels(device: GPUDevice): SsimKernels {
  let k = cache.get(device);
  if (k) return k;
  k = {
    p1: createKernel(device, "ssim:h1", PASS1, "blurMomentsH", [
      "uniform",
      "read-only-storage",
      "texture-unfilterable-array",
      "storage",
    ]),
    p2: createKernel(device, "ssim:partials", PASS2, "ssimPartials", [
      "uniform",
      "read-only-storage",
      "storage",
      "storage",
    ]),
    p3: createKernel(device, "ssim:h2", PASS3, "blurPartialsH", [
      "uniform",
      "read-only-storage",
      "storage",
    ]),
    p4: createKernel(device, "ssim:combine", PASS4, "combine", [
      "uniform",
      "read-only-storage",
      "read-only-storage",
      "texture-unfilterable-array",
      "storage",
    ]),
  };
  cache.set(device, k);
  return k;
}

/**
 * D-SSIM term for SplatTrainStep. `lossAccum[1]` receives mean SSIM (so
 * D-SSIM = 1 − value / steps).
 */
export class SsimLoss {
  private readonly k: SsimKernels;
  private readonly uniform: GPUBuffer;
  private readonly h1: GPUBuffer;
  private readonly partials: GPUBuffer;
  private readonly h2: GPUBuffer;
  private groups: GPUBindGroup[] | null = null;
  private groupKey: GPUBuffer | null = null;

  constructor(
    private readonly device: GPUDevice,
    readonly width: number,
    readonly height: number,
    private readonly targets: GPUTexture,
    private readonly dImage: GPUBuffer,
    private readonly lossAccum: GPUBuffer,
  ) {
    this.k = kernels(device);
    const n = width * height;
    this.uniform = createBuffer(
      device,
      "ssim:params",
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.h1 = createBuffer(device, "ssim:h1", n * 5 * 16, STORAGE_RW);
    this.partials = createBuffer(
      device,
      "ssim:partials",
      n * 3 * 16,
      STORAGE_RW,
    );
    this.h2 = createBuffer(device, "ssim:h2", n * 3 * 16, STORAGE_RW);
  }

  /** Accumulate λ·D-SSIM gradients into dImage. `image` = rendered prediction. */
  encode(
    pass: GPUComputePassEncoder,
    image: GPUBuffer,
    layer: number,
    lambda: number,
  ): void {
    const u = new ArrayBuffer(32);
    const ui = new Uint32Array(u);
    const uf = new Float32Array(u);
    ui[0] = this.width;
    ui[1] = this.height;
    ui[2] = layer;
    uf[4] = lambda;
    uf[5] = 1 / (this.width * this.height);
    this.device.queue.writeBuffer(this.uniform, 0, u);
    if (!this.groups || this.groupKey !== image) {
      const view = this.targets.createView({ dimension: "2d-array" });
      this.groups = [
        bindGroup(this.device, this.k.p1, [this.uniform, image, view, this.h1]),
        bindGroup(this.device, this.k.p2, [
          this.uniform,
          this.h1,
          this.partials,
          this.lossAccum,
        ]),
        bindGroup(this.device, this.k.p3, [
          this.uniform,
          this.partials,
          this.h2,
        ]),
        bindGroup(this.device, this.k.p4, [
          this.uniform,
          this.h2,
          image,
          view,
          this.dImage,
        ]),
      ];
      this.groupKey = image;
    }
    const wx = Math.ceil(this.width / 16);
    const wy = Math.ceil(this.height / 16);
    const ks = [this.k.p1, this.k.p2, this.k.p3, this.k.p4];
    for (let i = 0; i < 4; i++) {
      pass.setPipeline(ks[i]!.pipeline);
      pass.setBindGroup(0, this.groups[i]!);
      pass.dispatchWorkgroups(wx, wy, 1);
    }
  }

  /** Debug helper: read accumulated mean SSIM. */
  async readSsim(): Promise<number> {
    return (
      new Float32Array(
        await readBuffer(this.device, this.lossAccum, 4, 4),
      )[0] ?? 0
    );
  }

  destroy(): void {
    this.uniform.destroy();
    this.h1.destroy();
    this.partials.destroy();
    this.h2.destroy();
  }
}
