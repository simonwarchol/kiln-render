/**
 * Capture an orbit of kiln renders as a Nerfstudio dataset (PNG + transforms.json),
 * optionally with Brush init.ply, packaged as a zip.
 */

import { zipSync } from "fflate";
import { mat4 } from "wgpu-matrix";
import type { Camera } from "../core/camera.js";
import type { DatasetConfig } from "../core/config.js";
import type { Renderer } from "../core/renderer.js";
import type { TransferFunction } from "../core/transfer-function.js";
import type { DataProvider } from "../data/data-provider.js";
import type { StreamingManager } from "../streaming/streaming-manager.js";
import {
  captureRendererFrame,
  nextAnimationFrame,
  rgbaToPng,
  waitForBricksLoaded,
} from "./capture-frame.js";
import { buildVoxelInitPly } from "./init-ply.js";

export interface SplatCaptureOptions {
  /** Number of orbit views (default 48) */
  viewCount?: number;
  /** Orbit distance in normalized units (default = current camera distance) */
  distance?: number;
  /** TAA settle frames per view (default 8) */
  settleFrames?: number;
  /** Include voxel init.ply (default true) */
  includeInitPly?: boolean;
  /** Override init.ply pyramid level (0 = finest). Default: auto (finest that fits). */
  initLod?: number;
  /** Max Gaussians in the Brush seed init.ply (not the trained product). */
  maxSplats?: number;
  /** Max bricks to sample for the seed init.ply. */
  maxInitBricks?: number;
  /** Progress callback 0–1 */
  onProgress?: (fraction: number, label: string) => void;
  /**
   * Streaming + canvas used to wait for bricks and present the orbit live.
   * Required for correct captures of fine LODs.
   */
  streaming?: StreamingManager;
  canvas?: HTMLCanvasElement;
  /** Present each settle frame to this swapchain (user sees rotation). */
  present?: () => GPUTextureView;
}

export interface SplatDatasetResult {
  /** Nerfstudio zip (transforms.json + images/ + optional seed init.ply) */
  zip: Uint8Array;
  /** Voxel seed PLY for Brush initialization (not the trained product) */
  appearancePly: Uint8Array | null;
  viewCount: number;
  width: number;
  height: number;
}

const CAMERA_FOV_Y = Math.PI / 4;

/** Default long-side pixel count for orbit captures (independent of the UI window). */
export const DEFAULT_CAPTURE_MAX_DIM = 1920;

/** Fit `maxDim` on the long side, preserving aspect, clamped to the GPU texture limit. */
export function resolveCaptureSize(
  aspectWidth: number,
  aspectHeight: number,
  maxDim: number,
  gpuMax: number,
): { width: number; height: number } {
  const cap = Math.max(1, Math.min(maxDim, gpuMax));
  const aw = Math.max(1, aspectWidth);
  const ah = Math.max(1, aspectHeight);
  if (aw >= ah) {
    const width = cap;
    const height = Math.max(1, Math.min(gpuMax, Math.round(width * (ah / aw))));
    return { width, height };
  }
  const height = cap;
  const width = Math.max(1, Math.min(gpuMax, Math.round(height * (aw / ah))));
  return { width, height };
}

/** Fibonacci-sphere directions on the unit sphere. */
function sphereDirections(n: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push([Math.cos(theta) * radius, y, Math.sin(theta) * radius]);
  }
  return out;
}

function lookAtC2W(
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number],
): number[][] {
  const view = mat4.lookAt(eye, target, up);
  const c2w = mat4.invert(view);
  if (!c2w) throw new Error("Failed to invert view matrix");
  const m = Array.from(c2w);
  return [
    [m[0]!, m[4]!, m[8]!, m[12]!],
    [m[1]!, m[5]!, m[9]!, m[13]!],
    [m[2]!, m[6]!, m[10]!, m[14]!],
    [m[3]!, m[7]!, m[11]!, m[15]!],
  ];
}

/**
 * Capture orbit views + transforms.json (+ optional init.ply) into a zip.
 */
export async function captureSplatDataset(
  device: GPUDevice,
  renderer: Renderer,
  camera: Camera,
  provider: DataProvider,
  config: DatasetConfig,
  tf: TransferFunction,
  opts: SplatCaptureOptions = {},
): Promise<SplatDatasetResult> {
  const viewCount = opts.viewCount ?? 48;
  const settleFrames = opts.settleFrames ?? 8;
  const includeInitPly = opts.includeInitPly ?? true;
  const onProgress = opts.onProgress ?? (() => {});
  const streaming = opts.streaming;
  const canvas = opts.canvas;
  const present = opts.present;

  const savedOrbit = camera.getOrbitState();
  const distance = opts.distance ?? savedOrbit[2];
  const target: [number, number, number] = [
    savedOrbit[3],
    savedOrbit[4],
    savedOrbit[5],
  ];
  const dirs = sphereDirections(viewCount);
  const upSign = camera.getUpAxis().startsWith("-") ? -1 : 1;

  const files: Record<string, Uint8Array> = {};
  const frames: Array<{
    file_path: string;
    transform_matrix: number[][];
  }> = [];

  let width = 0;
  let height = 0;

  try {
    for (let i = 0; i < viewCount; i++) {
      const dir = dirs[i]!;
      const rotX =
        upSign * Math.asin(Math.max(-1, Math.min(1, dir[1] * upSign)));
      const rotY = Math.atan2(dir[0], dir[2]);
      camera.setOrbitState([
        rotX,
        rotY,
        distance,
        target[0],
        target[1],
        target[2],
      ]);

      onProgress(
        i / (viewCount + (includeInitPly ? 1 : 0)),
        `View ${i + 1}/${viewCount}: loading bricks…`,
      );

      // Show the new camera pose immediately (even before bricks finish).
      if (present) {
        renderer.resetAccumulation();
        renderer.render(present(), camera);
        await nextAnimationFrame();
      }

      if (streaming && canvas) {
        await waitForBricksLoaded(streaming, camera, canvas);
        onProgress(
          (i + 0.5) / (viewCount + (includeInitPly ? 1 : 0)),
          `View ${i + 1}/${viewCount}: capturing…`,
        );
      }

      const frame = await captureRendererFrame(device, renderer, camera, {
        settleFrames,
        transparentBackground: true,
        present,
        yieldFrame: true,
      });
      width = frame.width;
      height = frame.height;
      const png = await rgbaToPng(frame.width, frame.height, frame.rgba);
      const name = `frame_${String(i).padStart(5, "0")}.png`;
      files[`images/${name}`] = png;

      const eye: [number, number, number] = [
        camera.position[0]!,
        camera.position[1]!,
        camera.position[2]!,
      ];
      frames.push({
        file_path: `images/${name}`,
        transform_matrix: lookAtC2W(eye, target, camera.getUpVector()),
      });
    }
  } finally {
    camera.setOrbitState(savedOrbit);
  }

  const fl = (0.5 * height) / Math.tan(CAMERA_FOV_Y / 2);
  const transforms = {
    camera_model: "OPENCV",
    fl_x: fl,
    fl_y: fl,
    cx: width / 2,
    cy: height / 2,
    w: width,
    h: height,
    frames,
  };
  files["transforms.json"] = new TextEncoder().encode(
    JSON.stringify(transforms, null, 2),
  );

  let appearancePly: Uint8Array | null = null;
  if (includeInitPly) {
    onProgress(viewCount / (viewCount + 1), "Building seed init.ply…");
    appearancePly = await buildVoxelInitPly(
      provider,
      config,
      tf,
      renderer.windowCenter,
      renderer.windowWidth,
      {
        numChannels: renderer.numChannels,
        channelColors: renderer.channelColors,
        channelWindowCenter: renderer.channelWindowCenter,
        channelWindowWidth: renderer.channelWindowWidth,
        targetFormat: renderer.canvas.format,
        floatMin: renderer.floatMin,
        floatMax: renderer.floatMax,
        lod: opts.initLod,
        maxSplats: opts.maxSplats,
        maxInitBricks: opts.maxInitBricks,
        onProgress: (f, label) => {
          const base = viewCount / (viewCount + 1);
          onProgress(base + f / (viewCount + 1), label);
        },
      },
    );
    files["init.ply"] = appearancePly;
  }

  onProgress(1, "Zipping dataset");
  const zip = zipSync(files, { level: 6 });
  return { zip, appearancePly, viewCount, width, height };
}
