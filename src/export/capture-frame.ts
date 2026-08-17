/**
 * GPU frame readback for splat dataset capture.
 * Blits the current TAA/compute result to rgba8unorm and copies to CPU.
 */

import type { Camera } from "../core/camera.js";
import type { Renderer } from "../core/renderer.js";
import { blitShader } from "../shaders/index.js";
import type { StreamingManager } from "../streaming/streaming-manager.js";

export interface CapturedFrame {
  width: number;
  height: number;
  /** RGBA8 pixels, row-major, premultiplied-ish as blit outputs */
  rgba: Uint8ClampedArray;
}

export interface CaptureFrameOptions {
  settleFrames?: number;
  transparentBackground?: boolean;
  /**
   * When set, each settle frame is also presented here (e.g. canvas swapchain)
   * so the user sees the orbit during export.
   */
  present?: () => GPUTextureView;
  /** Yield to the browser after each presented settle frame (default true if present). */
  yieldFrame?: boolean;
}

/** rAF helper so the canvas actually paints between capture steps. */
export function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Force a desired-set recompute and drain the load queue until no bricks are
 * pending (or timeout). Call after moving the camera for a capture view.
 */
export async function waitForBricksLoaded(
  streaming: StreamingManager,
  camera: Camera,
  canvas: HTMLCanvasElement,
  opts: { timeoutMs?: number; stableFrames?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const stableFrames = opts.stableFrames ?? 3;
  const t0 = performance.now();
  let idleStreak = 0;

  streaming.forceUpdate(camera, canvas);

  while (performance.now() - t0 < timeoutMs) {
    streaming.update(camera, canvas);
    const pending = streaming.getStats().pendingCount;
    if (pending === 0 && streaming.baseLodLoaded) {
      idleStreak++;
      if (idleStreak >= stableFrames) return;
    } else {
      idleStreak = 0;
    }
    await nextAnimationFrame();
  }
  console.warn(
    "[Kiln] waitForBricksLoaded timed out with pending bricks still in flight",
  );
}

/**
 * Capture the current rendered volume (compute + TAA) as RGBA8.
 * Uses a transparent clear so empty space stays alpha=0 for Brush masking.
 */
export async function captureRendererFrame(
  device: GPUDevice,
  renderer: Renderer,
  camera: Camera,
  opts: CaptureFrameOptions = {},
): Promise<CapturedFrame> {
  const settleFrames = opts.settleFrames ?? 8;
  const transparent = opts.transparentBackground ?? true;
  const present = opts.present;
  const yieldFrame = opts.yieldFrame ?? !!present;

  const width = renderer.captureWidth;
  const height = renderer.captureHeight;
  if (width < 1 || height < 1) {
    throw new Error("Renderer has no screen size; call resize first");
  }

  const scale = renderer.renderScale;
  const cw = Math.max(1, Math.round(width * scale));
  const ch = Math.max(1, Math.round(height * scale));

  const captureTex = device.createTexture({
    size: [cw, ch],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.TEXTURE_BINDING,
  });
  const depthTex = device.createTexture({
    size: [cw, ch],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const blitModule = device.createShaderModule({ code: blitShader });
  const capturePipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: blitModule, entryPoint: "vs" },
    fragment: {
      module: blitModule,
      entryPoint: "fs",
      targets: [
        {
          format: "rgba8unorm",
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
    depthStencil: {
      depthWriteEnabled: false,
      depthCompare: "always",
      format: "depth24plus",
    },
  });

  const clear: GPUColor = transparent ? [0, 0, 0, 0] : [0.05, 0.05, 0.05, 1];

  const savedWire = renderer.showWireframe;
  const savedAxis = renderer.showAxis;
  renderer.showWireframe = false;
  renderer.showAxis = false;
  renderer.resetAccumulation();

  let tempPresent: GPUTexture | null = null;
  if (!present) {
    tempPresent = device.createTexture({
      size: [width, height],
      format: navigator.gpu.getPreferredCanvasFormat(),
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  for (let i = 0; i < settleFrames; i++) {
    const colorView = present ? present() : tempPresent!.createView();
    renderer.render(colorView, camera);
    if (yieldFrame) await nextAnimationFrame();
  }

  const sourceView = renderer.getBlitSourceView();
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  const bg = device.createBindGroup({
    layout: capturePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sourceView },
      { binding: 1, resource: sampler },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: captureTex.createView(),
        clearValue: clear,
        loadOp: "clear",
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: depthTex.createView(),
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "discard",
    },
  });
  pass.setPipeline(capturePipeline);
  pass.setBindGroup(0, bg);
  pass.draw(3);
  pass.end();

  const bytesPerRow = Math.ceil((cw * 4) / 256) * 256;
  const bufferSize = bytesPerRow * ch;
  const staging = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer(
    { texture: captureTex },
    { buffer: staging, bytesPerRow },
    [cw, ch, 1],
  );
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(staging.getMappedRange());
  const rgba = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const src = y * bytesPerRow;
    const dst = y * cw * 4;
    rgba.set(mapped.subarray(src, src + cw * 4), dst);
  }
  staging.unmap();

  renderer.showWireframe = savedWire;
  renderer.showAxis = savedAxis;

  captureTex.destroy();
  depthTex.destroy();
  tempPresent?.destroy();
  staging.destroy();

  return { width: cw, height: ch, rgba };
}

/** Encode RGBA8 as PNG via OffscreenCanvas / HTMLCanvasElement. */
export async function rgbaToPng(
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
): Promise<Uint8Array> {
  const pixels = new Uint8ClampedArray(rgba.length);
  pixels.set(rgba);
  const imageData = new ImageData(pixels, width, height);
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d unavailable");
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}
