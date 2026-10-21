/**
 * Volume canvas (atlas) and test volume generation
 */

import type { BitDepth, BrickData } from "../data/data-provider.js";
import { ATLAS_SIZE } from "./config.js";

export interface VolumeCanvas {
  texture: GPUTexture;
  size: number;
  bitDepth: BitDepth;
  format: GPUTextureFormat;
}

/**
 * Detect best supported texture format for 16-bit data.
 * Tries r16float first (filterable), falls back to r8unorm.
 */
export function detectBest16BitFormat(device: GPUDevice): GPUTextureFormat {
  const formats: GPUTextureFormat[] = ["r16float"];

  for (const format of formats) {
    try {
      const testTexture = device.createTexture({
        size: [1, 1, 1],
        format,
        dimension: "3d",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      testTexture.destroy();
      console.log(`[Kiln] Using ${format} for 16-bit atlas texture`);
      return format;
    } catch (_) {
      console.warn(`[Kiln] Format ${format} not supported, trying next...`);
    }
  }

  console.warn(
    "[Kiln] No 16-bit formats supported, falling back to r8unorm (quality loss)",
  );
  return "r8unorm";
}

/** Create empty volume canvas (atlas texture). Size defaults to the full ATLAS_SIZE. */
export function createVolumeCanvas(
  device: GPUDevice,
  bitDepth: BitDepth,
  format: GPUTextureFormat,
  atlasSize: number = ATLAS_SIZE,
): VolumeCanvas {
  const texture = device.createTexture({
    size: [atlasSize, atlasSize, atlasSize],
    format,
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  return { texture, size: atlasSize, bitDepth, format };
}

/**
 * Write volume data into canvas at specified offset
 * Handles both 8-bit and 16-bit data based on canvas bitDepth
 */
export function writeToCanvas(
  device: GPUDevice,
  canvas: VolumeCanvas,
  data: BrickData,
  size: [number, number, number],
  offset: [number, number, number] = [0, 0, 0],
) {
  const bytesPerVoxel = canvas.bitDepth === 16 ? 2 : 1;
  device.queue.writeTexture(
    { texture: canvas.texture, origin: offset },
    data.buffer,
    {
      offset: data.byteOffset,
      bytesPerRow: size[0] * bytesPerVoxel,
      rowsPerImage: size[1],
    },
    size,
  );
}
