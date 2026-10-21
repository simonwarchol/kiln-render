/**
 * VolumeResources — atlas textures, indirection table, and slot allocator.
 * Shared between Renderer and StreamingManager.
 */

import type { BitDepth } from "../data/data-provider.js";
import { AtlasAllocator } from "../streaming/atlas-allocator.js";
import type { DatasetConfig } from "./config.js";
import { GRID_SIZE, MAX_CHANNELS, PHYSICAL_BRICK_SIZE } from "./config.js";
import { IndirectionTable } from "./indirection.js";
import { createVolumeCanvas, type VolumeCanvas } from "./volume.js";

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
        canvases.push(
          createVolumeCanvas(device, bitDepth, textureFormat, this.atlasSize),
        );
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
  }

  /** View for atlas channel ch (dummy if ch >= numChannels) */
  atlasView(ch: number): GPUTextureView {
    return ch < this.numChannels
      ? this.canvases[ch]!.texture.createView()
      : this.dummyTexture.createView();
  }
}
