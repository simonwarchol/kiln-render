/**
 * VolumeResources — atlas textures, indirection table, slot allocator, and
 * the per-slot channel maxima the ray marcher skips empty bricks by.
 * Shared between Renderer and StreamingManager.
 */

import type { BitDepth, BrickData } from "../data/data-provider.js";
import { buildSlotMaxShader } from "../shaders/index.js";
import { AtlasAllocator } from "../streaming/atlas-allocator.js";
import type { DatasetConfig } from "./config.js";
import { GRID_SIZE, MAX_CHANNELS, PHYSICAL_BRICK_SIZE } from "./config.js";
import { IndirectionTable } from "./indirection.js";

export interface VolumeCanvas {
  texture: GPUTexture;
  size: number;
  bitDepth: BitDepth;
  format: GPUTextureFormat;
}

interface SlotPosition {
  x: number;
  y: number;
  z: number;
}

/** Floats per atlas slot in {@link VolumeResources.slotMax}. */
export const SLOT_MAX_STRIDE = 8;
/** slotMax value of a slot not yet measured: never skipped. */
const SLOT_MAX_UNKNOWN = 1e30;
/** slotMax value of a channel that holds nothing (hidden when its brick loaded). */
const SLOT_MAX_NONE = new Float32Array([-1e30]);

export class VolumeResources {
  readonly numChannels: number;

  /** Atlas grid dimension (slots per axis) — may be shrunk to fit a VRAM budget */
  readonly gridSize: number;

  /** Atlas texture dimension in voxels (gridSize × PHYSICAL_BRICK_SIZE) */
  readonly atlasSize: number;

  /** Per-channel atlas textures (length === numChannels) */
  readonly canvases: VolumeCanvas[];

  /** Indirection table for virtual texturing */
  readonly indirection: IndirectionTable;

  /** Atlas slot allocator (LRU with thrash guard) */
  readonly allocator: AtlasAllocator;

  /** 1×1×1 dummy texture bound to unused channel slots */
  private readonly dummyTexture: GPUTexture;

  /**
   * Per atlas slot, the largest value stored for each channel (atlas units,
   * 8 floats per slot: channels 0–5 + padding), reduced on the GPU after each
   * upload. The ray marcher skips a brick channel whose maximum can't reach
   * the channel's window.
   */
  readonly slotMax: GPUBuffer;
  private readonly device: GPUDevice;
  /** Jobs (slot * SLOT_MAX_STRIDE + channel) waiting for a reduction */
  private readonly pendingMax = new Set<number>();
  private readonly jobs: GPUBuffer;
  private readonly jobScratch: Uint32Array<ArrayBuffer>;
  private readonly maxPipeline: GPUComputePipeline;
  private readonly maxBindGroup: GPUBindGroup;
  private zeroBrick: BrickData | null = null;

  /** Channel-0 alias for single-channel callers */
  get canvas(): VolumeCanvas {
    return this.canvases[0]!;
  }

  constructor(
    device: GPUDevice,
    bitDepth: BitDepth,
    textureFormat: GPUTextureFormat,
    config: DatasetConfig,
    numChannels = 1,
    gridSize: number = GRID_SIZE,
  ) {
    this.numChannels = Math.min(Math.max(1, numChannels), MAX_CHANNELS);
    this.gridSize = gridSize;
    this.atlasSize = gridSize * PHYSICAL_BRICK_SIZE;

    const canvases: VolumeCanvas[] = [];
    let dummyTexture: GPUTexture | undefined;
    let indirection: IndirectionTable | undefined;
    try {
      for (let i = 0; i < this.numChannels; i++) {
        const size = this.atlasSize;
        canvases.push({
          texture: device.createTexture({
            label: `atlas:ch${i}`,
            size: [size, size, size],
            format: textureFormat,
            dimension: "3d",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          }),
          size,
          bitDepth,
          format: textureFormat,
        });
      }
      dummyTexture = device.createTexture({
        size: [1, 1, 1],
        format: textureFormat,
        dimension: "3d",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      indirection = new IndirectionTable(device, config);
    } catch (err) {
      for (const canvas of canvases) {
        try {
          canvas.texture.destroy();
        } catch {
          /* already invalid */
        }
      }
      try {
        dummyTexture?.destroy();
      } catch {
        /* already invalid */
      }
      try {
        indirection?.texture.destroy();
      } catch {
        /* already invalid */
      }
      throw err;
    }

    this.canvases = canvases;
    this.dummyTexture = dummyTexture;
    this.indirection = indirection;
    this.allocator = new AtlasAllocator(gridSize);
    this.device = device;
    const entries = gridSize ** 3 * SLOT_MAX_STRIDE;
    this.slotMax = device.createBuffer({
      label: "atlas:slot-max",
      size: entries * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.slotMax.getMappedRange()).fill(SLOT_MAX_UNKNOWN);
    this.slotMax.unmap();
    this.jobs = device.createBuffer({
      label: "atlas:slot-max-jobs",
      size: entries * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.jobScratch = new Uint32Array(entries);
    this.maxPipeline = device.createComputePipeline({
      label: "atlas:slot-max",
      layout: "auto",
      compute: {
        module: device.createShaderModule({
          code: buildSlotMaxShader(this.atlasSize),
        }),
        entryPoint: "main",
      },
    });
    this.maxBindGroup = device.createBindGroup({
      layout: this.maxPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.jobs } },
        { binding: 1, resource: { buffer: this.slotMax } },
        ...Array.from({ length: MAX_CHANNELS }, (_, ch) => ({
          binding: 2 + ch,
          resource: this.atlasView(ch),
        })),
      ],
    });
  }

  private maxJob(slot: SlotPosition, ch: number): number {
    const g = this.gridSize;
    return ((slot.z * g + slot.y) * g + slot.x) * SLOT_MAX_STRIDE + ch;
  }

  /**
   * Upload one channel of a physical brick into atlas `slot` (`null` zero-fills:
   * recycled slots still hold the previous brick) and queue its maximum.
   */
  writeBrick(slot: SlotPosition, ch: number, data: BrickData | null): void {
    const canvas = this.canvases[ch]!;
    const size = PHYSICAL_BRICK_SIZE;
    const src = data ?? this.zeros(canvas.bitDepth);
    this.device.queue.writeTexture(
      {
        texture: canvas.texture,
        origin: [slot.x * size, slot.y * size, slot.z * size],
      },
      src.buffer as ArrayBuffer,
      {
        offset: src.byteOffset,
        bytesPerRow: size * (canvas.bitDepth === 16 ? 2 : 1),
        rowsPerImage: size,
      },
      [size, size, size],
    );
    this.pendingMax.add(this.maxJob(slot, ch));
  }

  /**
   * Mark channel `ch` of `slot` as holding nothing — it was hidden when the
   * brick loaded, so its texels are stale. The marcher then skips it until
   * the channel is backfilled.
   */
  clearChannel(slot: SlotPosition, ch: number): void {
    const job = this.maxJob(slot, ch);
    this.pendingMax.delete(job);
    this.device.queue.writeBuffer(this.slotMax, job * 4, SLOT_MAX_NONE);
  }

  /** Encode the queued slot-max reductions (before ray marching). */
  encodeSlotMax(encoder: GPUCommandEncoder): void {
    const count = this.pendingMax.size;
    if (count === 0) return;
    let i = 0;
    for (const job of this.pendingMax) this.jobScratch[i++] = job;
    this.pendingMax.clear();
    this.device.queue.writeBuffer(this.jobs, 0, this.jobScratch, 0, count);
    const pass = encoder.beginComputePass({ label: "atlas:slot-max" });
    pass.setPipeline(this.maxPipeline);
    pass.setBindGroup(0, this.maxBindGroup);
    pass.dispatchWorkgroups(count);
    pass.end();
  }

  private zeros(bitDepth: BitDepth): BrickData {
    const voxels = PHYSICAL_BRICK_SIZE ** 3;
    if (this.zeroBrick?.BYTES_PER_ELEMENT !== bitDepth / 8)
      this.zeroBrick =
        bitDepth === 16 ? new Uint16Array(voxels) : new Uint8Array(voxels);
    return this.zeroBrick;
  }

  /** Free atlas + indirection GPU textures (safe to call more than once). */
  destroy(): void {
    for (const canvas of this.canvases) {
      try {
        canvas.texture.destroy();
      } catch {
        /* already invalid */
      }
    }
    try {
      this.dummyTexture.destroy();
    } catch {
      /* already invalid */
    }
    try {
      this.indirection.texture.destroy();
    } catch {
      /* already invalid */
    }
    this.slotMax.destroy();
    this.jobs.destroy();
  }

  /** View for atlas channel ch (dummy if ch >= numChannels) */
  atlasView(ch: number): GPUTextureView {
    return ch < this.numChannels
      ? this.canvases[ch]!.texture.createView()
      : this.dummyTexture.createView();
  }
}
