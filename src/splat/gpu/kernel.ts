/**
 * Small helpers for compute kernels with explicit bind-group layouts.
 *
 * Explicit layouts (instead of `layout: "auto"`) let one bind group carry
 * bindings an entry point doesn't statically use, so kernels that share a
 * module can share resource lists without "binding not in layout" errors.
 */

export type BindingKind =
  | "uniform"
  | "uniform-dynamic"
  | "storage"
  | "read-only-storage"
  | "texture-unfilterable-array";

export interface Kernel {
  readonly label: string;
  readonly pipeline: GPUComputePipeline;
  readonly layout: GPUBindGroupLayout;
}

function layoutEntry(
  binding: number,
  kind: BindingKind,
  visibility: number,
): GPUBindGroupLayoutEntry {
  switch (kind) {
    case "uniform":
      return { binding, visibility, buffer: { type: "uniform" } };
    case "uniform-dynamic":
      return {
        binding,
        visibility,
        buffer: { type: "uniform", hasDynamicOffset: true },
      };
    case "storage":
      return { binding, visibility, buffer: { type: "storage" } };
    case "read-only-storage":
      return { binding, visibility, buffer: { type: "read-only-storage" } };
    case "texture-unfilterable-array":
      return {
        binding,
        visibility,
        texture: {
          sampleType: "unfilterable-float",
          viewDimension: "2d-array",
        },
      };
  }
}

export function createBindGroupLayout(
  device: GPUDevice,
  label: string,
  bindings: readonly BindingKind[],
  visibility: number = GPUShaderStage.COMPUTE,
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label,
    entries: bindings.map((kind, i) => layoutEntry(i, kind, visibility)),
  });
}

const moduleCache = new WeakMap<GPUDevice, Map<string, GPUShaderModule>>();

export function shaderModule(
  device: GPUDevice,
  label: string,
  code: string,
): GPUShaderModule {
  let cache = moduleCache.get(device);
  if (!cache) {
    cache = new Map();
    moduleCache.set(device, cache);
  }
  let mod = cache.get(code);
  if (!mod) {
    mod = device.createShaderModule({ label, code });
    cache.set(code, mod);
  }
  return mod;
}

/** Build a compute kernel whose bindings are 0..n-1 in group 0. */
export function createKernel(
  device: GPUDevice,
  label: string,
  code: string,
  entryPoint: string,
  bindings: readonly BindingKind[],
  constants?: Record<string, number>,
): Kernel {
  const layout = createBindGroupLayout(device, `${label}:layout`, bindings);
  const pipeline = device.createComputePipeline({
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: {
      module: shaderModule(device, label, code),
      entryPoint,
      constants,
    },
  });
  return { label, pipeline, layout };
}

export type BindingResourceLike = GPUBuffer | GPUBindingResource;

function toResource(r: BindingResourceLike): GPUBindingResource {
  return r instanceof GPUBuffer ? { buffer: r } : r;
}

/** Bind resources[i] to binding i of the kernel's layout. */
export function bindGroup(
  device: GPUDevice,
  kernel: Kernel,
  resources: readonly BindingResourceLike[],
): GPUBindGroup {
  return device.createBindGroup({
    label: `${kernel.label}:bg`,
    layout: kernel.layout,
    entries: resources.map((r, i) => ({
      binding: i,
      resource: toResource(r),
    })),
  });
}

export const MAX_WORKGROUPS_PER_DIM = 65535;

/** Split a 1D workgroup count into a 2D grid that respects the per-dim limit. */
export function grid2d(workgroups: number): [number, number] {
  const n = Math.max(1, Math.ceil(workgroups));
  if (n <= MAX_WORKGROUPS_PER_DIM) return [n, 1];
  return [MAX_WORKGROUPS_PER_DIM, Math.ceil(n / MAX_WORKGROUPS_PER_DIM)];
}

export function dispatch1d(
  pass: GPUComputePassEncoder,
  kernel: Kernel,
  group: GPUBindGroup,
  workgroups: number,
  dynamicOffsets?: number[],
): void {
  if (workgroups <= 0) return;
  pass.setPipeline(kernel.pipeline);
  pass.setBindGroup(0, group, dynamicOffsets);
  const [x, y] = grid2d(workgroups);
  pass.dispatchWorkgroups(x, y, 1);
}

/**
 * WGSL `fn <fnName>(i: u32, v: f32)`: float add into `<array>` (an
 * `array<atomic<u32>>`) by compare-exchange — WebGPU has no float atomics.
 * Zero adds are skipped.
 */
export function wgslAtomicAddF(fnName: string, array: string): string {
  return /* wgsl */ `
fn ${fnName}(i: u32, v: f32) {
  if (v == 0.0) { return; }
  var old = atomicLoad(&${array}[i]);
  loop {
    let r = atomicCompareExchangeWeak(&${array}[i], old, bitcast<u32>(bitcast<f32>(old) + v));
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}`;
}

/** WGSL snippet: linear workgroup index for 2D-split 1D dispatches. */
export const WGSL_LINEAR_WORKGROUP = /* wgsl */ `
fn linearWorkgroup(wid: vec3u, nwg: vec3u) -> u32 {
  return wid.x + wid.y * nwg.x;
}
`;

export function createBuffer(
  device: GPUDevice,
  label: string,
  size: number,
  usage: number,
): GPUBuffer {
  return device.createBuffer({
    label,
    size: Math.max(16, Math.ceil(size / 4) * 4),
    usage,
  });
}

export const STORAGE_RW =
  GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

/** Read a GPU buffer back to the CPU (debug / occasional stats only). */
export async function readBuffer(
  device: GPUDevice,
  src: GPUBuffer,
  byteOffset = 0,
  byteLength: number = src.size - byteOffset,
): Promise<ArrayBuffer> {
  const staging = device.createBuffer({
    size: Math.ceil(byteLength / 4) * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(
    src,
    byteOffset,
    staging,
    0,
    Math.ceil(byteLength / 4) * 4,
  );
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = staging.getMappedRange().slice(0, byteLength);
  staging.unmap();
  staging.destroy();
  return out;
}

/**
 * Optional GPU timestamp profiler (needs the "timestamp-query" feature).
 * Each stage gets its own compute pass with begin/end timestamps.
 */
export class GpuProfiler {
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuf: GPUBuffer;
  private labels: string[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly maxStages = 64,
  ) {
    this.querySet = device.createQuerySet({
      type: "timestamp",
      count: maxStages * 2,
    });
    this.resolveBuf = device.createBuffer({
      size: maxStages * 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
  }

  begin(encoder: GPUCommandEncoder, label: string): GPUComputePassEncoder {
    const i = this.labels.length;
    if (i >= this.maxStages) return encoder.beginComputePass({ label });
    this.labels.push(label);
    return encoder.beginComputePass({
      label,
      timestampWrites: {
        querySet: this.querySet,
        beginningOfPassWriteIndex: i * 2,
        endOfPassWriteIndex: i * 2 + 1,
      },
    });
  }

  /** Resolve and read stage durations (ms, summed per label), then reset. */
  async read(): Promise<Record<string, number>> {
    const n = this.labels.length;
    const out: Record<string, number> = {};
    if (n === 0) return out;
    const enc = this.device.createCommandEncoder();
    enc.resolveQuerySet(this.querySet, 0, n * 2, this.resolveBuf, 0);
    this.device.queue.submit([enc.finish()]);
    const t = new BigUint64Array(
      await readBuffer(this.device, this.resolveBuf, 0, n * 16),
    );
    for (let i = 0; i < n; i++) {
      const ms = Number(t[i * 2 + 1]! - t[i * 2]!) / 1e6;
      out[this.labels[i]!] = (out[this.labels[i]!] ?? 0) + ms;
    }
    this.labels = [];
    return out;
  }

  destroy(): void {
    this.querySet.destroy();
    this.resolveBuf.destroy();
  }
}

/**
 * Hands out compute passes for successive stages: one shared pass normally,
 * a separate timestamped pass per stage when profiling.
 */
export class PassChain {
  private pass: GPUComputePassEncoder | null = null;

  constructor(
    private readonly encoder: GPUCommandEncoder,
    private readonly label: string,
    private readonly profiler?: GpuProfiler,
  ) {}

  stage(label: string): GPUComputePassEncoder {
    if (!this.profiler) {
      this.pass ??= this.encoder.beginComputePass({ label: this.label });
      return this.pass;
    }
    this.pass?.end();
    this.pass = this.profiler.begin(this.encoder, label);
    return this.pass;
  }

  end(): void {
    this.pass?.end();
    this.pass = null;
  }
}
