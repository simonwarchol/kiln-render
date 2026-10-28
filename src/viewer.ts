/**
 * KilnViewer — self-contained WebGPU volume renderer. Handles WebGPU init,
 * data provider setup, render loop, and resize. App layer handles UI.
 */

import { Camera, type UpAxis } from "./core/camera.js";
import {
  adapterMemoryHints,
  computeAtlasGrid,
  DatasetConfig,
  guessAtlasBudgetBytes,
  MIN_GRID_SIZE,
  nextSmallerAtlasGrid,
  PHYSICAL_BRICK_SIZE,
  readDeviceMemoryGiB,
} from "./core/config.js";
import { type DepthCue, depthCueFor } from "./core/depth-cue.js";
import { Renderer, type VolumeRenderMode } from "./core/renderer.js";
import { type TFPreset, TransferFunction } from "./core/transfer-function.js";
import { VolumeResources } from "./core/volume-resources.js";
import type {
  BitDepth,
  DataProvider,
  VolumeMetadata,
} from "./data/data-provider.js";
import {
  cloudFromParams,
  type GaussianCloud,
  mergeClouds,
  readPly,
  writePly,
} from "./splat/cloud.js";
import {
  type CapturedViews,
  captureViews,
  captureViewsAt,
  evaluateCloud,
  fitVolume,
  type SplatBuildHost,
  type SplatBuildOptions,
  trainCloud,
} from "./splat/splat-builder.js";
import { SplatLayer } from "./splat/splat-layer.js";
import {
  type Box,
  chooseTiles,
  mergeTileParams,
  tileBoxes,
} from "./splat/tiles.js";
import { StreamingManager } from "./streaming/streaming-manager.js";
import {
  ms,
  perfCount,
  perfEvent,
  perfOn,
  perfSample,
} from "./utils/perf-log.js";

/** A frame on the GPU, as perf logging tracks it. */
interface PerfFrame {
  start: number;
  /** When the camera started moving, for its first frame. */
  move: number | null;
  label: string;
  /** Full-resolution volume frame (accumulates towards convergence). */
  final: boolean;
  /** Frames already accumulated into the image this frame adds to. */
  accumulated: number;
}

/** What the canvas shows: the volume, the splats, or both side by side. */
export type DisplayMode = "volume" | "splats" | "split";

export interface ViewerOptions {
  /** Initial render mode */
  mode?: VolumeRenderMode;
  /** 16-bit window centre (0–1) */
  windowCenter?: number;
  /** 16-bit window width (0–1) */
  windowWidth?: number;
  /** DVR density / opacity scale (0.1–10, default 1) */
  densityScale?: number;
  /** Depth cue strength, 0 (off, default) to 1 — see {@link KilnViewer.depthCue} */
  depthCue?: number;
  /** Isosurface threshold (0–1) */
  isoValue?: number;
  /**
   * Canvas pixels per CSS pixel (default 1). Pass `devicePixelRatio` for a
   * sharp image on high-DPI screens. Data detail (LOD) is still chosen in CSS
   * pixels, so this sharpens the rendering without fetching finer bricks.
   */
  pixelRatio?: number;
  /** LOD screen-space error threshold in pixels */
  maxPixelError?: number;
  /**
   * Force streaming to a single pyramid level (0 = finest, maxLod = coarsest).
   * Omit / `null` for automatic screen-space-error selection.
   */
  forcedLod?: number | null;
  /**
   * Atlas VRAM budget in bytes. When omitted, Kiln buckets the adapter
   * (fallback / small maxBufferSize or ≤4 GiB RAM / full discrete cap).
   * The grid shrinks to fit; lower it for constrained GPUs, raise it to keep
   * 660³ for many channels.
   */
  atlasBudgetBytes?: number;
  /** Axis-aligned clip minimum, normalised 0–1 */
  clipMin?: [number, number, number];
  /** Axis-aligned clip maximum, normalised 0–1 */
  clipMax?: [number, number, number];
  /** Transfer function colour preset */
  tfPreset?: TFPreset;
  /** Transfer function opacity control points (overrides preset defaults) */
  tfPoints?: Array<{ x: number; y: number }>;
  /** Camera up axis */
  upAxis?: UpAxis;
  /** Camera orbit state [rx, ry, dist] or [rx, ry, dist, tx, ty, tz] */
  cam?:
    | [number, number, number]
    | [number, number, number, number, number, number];
  /** performance.now() at page load, used for time-to-first-render metric */
  pageLoadStart?: number;
  /** Slice plane positions, normalised 0–1 */
  sliceX?: number;
  sliceY?: number;
  sliceZ?: number;
  /** Slice plane visibility flags (default true) */
  showSliceX?: boolean;
  showSliceY?: boolean;
  showSliceZ?: boolean;
  /** Overlay toggles */
  showWireframe?: boolean;
  showAxis?: boolean;
}

/** Serialisable snapshot of viewer state — used by the share-URL feature */
export interface ViewerState {
  mode: VolumeRenderMode;
  windowCenter: number;
  windowWidth: number;
  densityScale: number;
  isoValue: number;
  /** Forced stream LOD, or `null` for automatic SSE selection */
  forcedLod: number | null;
  tfPreset: TFPreset;
  tfPoints: Array<{ x: number; y: number }>;
  upAxis: UpAxis;
  cam: [number, number, number, number, number, number];
  clipMin: [number, number, number];
  clipMax: [number, number, number];
  sliceX: number;
  sliceY: number;
  sliceZ: number;
  showSliceX: boolean;
  showSliceY: boolean;
  showSliceZ: boolean;
  showWireframe: boolean;
  showAxis: boolean;
}

const ATLAS_GRID_CAP_KEY = "kiln-atlas-grid-cap";

async function requestKilnDevice(adapter: GPUAdapter): Promise<GPUDevice> {
  const limits = adapter.limits;
  // Optional: subgroups speed up the splat depth sort.
  const features = (["subgroups"] as GPUFeatureName[]).filter((f) =>
    adapter.features.has(f),
  );
  return adapter.requestDevice({
    requiredFeatures: features,
    requiredLimits: {
      maxBufferSize: limits.maxBufferSize,
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      maxTextureDimension3D: limits.maxTextureDimension3D,
      maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
      maxTextureArrayLayers: limits.maxTextureArrayLayers,
      maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
    },
  });
}

function readStoredAtlasGridCap(): number | undefined {
  try {
    const n = Number(sessionStorage.getItem(ATLAS_GRID_CAP_KEY));
    if (Number.isInteger(n) && n >= MIN_GRID_SIZE && n <= 32) return n;
  } catch {
    /* private mode */
  }
  return undefined;
}

function storeAtlasGridCap(gridSize: number): void {
  try {
    sessionStorage.setItem(ATLAS_GRID_CAP_KEY, String(gridSize));
  } catch {
    /* private mode */
  }
}

async function createVolumeResourcesFittingDevice(
  adapter: GPUAdapter,
  device: GPUDevice,
  bitDepth: BitDepth,
  textureFormat: GPUTextureFormat,
  config: DatasetConfig,
  numChannels: number,
  startGridSize: number,
): Promise<{
  device: GPUDevice;
  resources: VolumeResources;
  gridSize: number;
}> {
  let gpu = device;
  let gridSize = startGridSize;

  for (;;) {
    let lost: GPUDeviceLostInfo | undefined;
    void gpu.lost.then((info) => {
      lost = info;
    });
    try {
      const resources = new VolumeResources(
        gpu,
        bitDepth,
        textureFormat,
        config,
        numChannels,
        gridSize,
      );
      await gpu.queue.onSubmittedWorkDone();
      if (lost && lost.reason !== "destroyed") {
        resources.destroy();
        throw new Error(lost.message || "GPU device lost");
      }
      return { device: gpu, resources, gridSize };
    } catch (err) {
      const next = nextSmallerAtlasGrid(gridSize);
      if (next === null) throw err;
      console.warn(
        `[Kiln] atlas ${gridSize}³ failed (${err instanceof Error ? err.message : String(err)}); retrying ${next}³`,
      );
      storeAtlasGridCap(next);
      if (lost && lost.reason !== "destroyed") {
        gpu = await requestKilnDevice(adapter);
      }
      gridSize = next;
    }
  }
}

/** Options for {@link KilnViewer.generateSplats}. */
export interface GenerateSplatsOptions extends SplatBuildOptions {
  /**
   * Render mode the splats reproduce (default: the displayed one, or volume
   * rendering for other modes).
   */
  renderMode?: "dvr" | "mip" | "iso";
  /** Volume-rendering density (default: the displayed one). */
  density?: number;
  /** Clip box to build from, 0–1 per axis (default: the displayed one). */
  region?: Box;
  /**
   * Split this many of the longest axes in two and build each tile with its
   * own close-up views, for finer detail; `targetCount` is shared.
   */
  tileSplits?: number;
  /**
   * Train each visible channel on its own, rendered in white, and return one
   * cloud tagged by channel (see `GaussianCloud.channelComposite`). The
   * display tints it with the live channel colours, so channels can be hidden
   * or recoloured without retraining. `targetCount` is shared among the
   * channels. Multichannel volumes only.
   */
  perChannel?: boolean;
  /** Called as each build starts (channels × tiles). */
  onTile?: (index: number, count: number) => void;
}

/**
 * Raw display window [start, end] within the normalisation range [lo, hi]
 * → the renderer's centre/width (fractions of the range).
 */
function setChannelWindowFromRange(
  renderer: Renderer,
  ch: number,
  w: { start: number; end: number },
  lo: number,
  hi: number,
): void {
  const range = hi - lo;
  if (!(range > 0)) return;
  const center = Math.max(0, Math.min(1, ((w.start + w.end) / 2 - lo) / range));
  const width = Math.max(0.01, Math.min(1, (w.end - w.start) / range));
  renderer.setChannelWindow(ch, center, width);
}

/** Render scale and accumulation length for draft (moving / loading) frames. */
const DRAFT_SCALE = 0.5;
const DRAFT_ACCUM_FRAMES = 4;
const DRAFT_STEP_SCALE = 2;
const FINAL_ACCUM_FRAMES = 16;
/** Frames stay draft this long after the camera last moved (flights, wheel). */
const DRAFT_AFTER_MOVE_MS = 150;

/** Viewer currently presenting to each canvas. */
const canvasOwner = new WeakMap<HTMLCanvasElement, KilnViewer>();

/**
 * Fit density for MIP builds. MIP ignores density, but the fit derives
 * opacity from it; this gives training a starting cloud near MIP brightness.
 */
const MIP_FIT_DENSITY = 1;

export class KilnViewer {
  readonly renderer: Renderer;
  readonly camera: Camera;
  readonly transferFunction: TransferFunction;
  readonly streamingManager: StreamingManager;
  readonly device: GPUDevice;
  readonly metadata: VolumeMetadata;
  readonly config: DatasetConfig;

  /** Optional callback invoked at the start of every render frame. */
  onBeforeFrame?: () => void;

  /** Callback invoked when float/channel ranges are derived during base LOD loading. */
  onChannelWindowsChanged?: () => void;

  /** Splat display mode (see `displayMode`). */
  private displayMode_: DisplayMode = "volume";
  /** Split position as a fraction of the canvas width (split mode). */
  private splitFraction_ = 0.5;
  private splatLayer: SplatLayer | null = null;
  private lastSplatVersion = -1;
  private building = false;

  private readonly dataProvider: DataProvider;
  private readonly context: GPUCanvasContext;
  private readonly canvasFormat: GPUTextureFormat;
  private readonly canvas: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver;
  private rafHandle = 0;
  private resizeTimer = 0;
  private disposed = false;
  private dirty = true;
  private lastCameraVersion = -1;
  private paused = false;
  /** A rendered frame is still executing on the GPU. */
  private gpuBusy = false;
  private lastCameraChange = 0;
  private pixelRatio_ = 1;
  /** Perf logging: a camera move from rest awaiting its first frame. */
  private perfMove: number | null = null;
  /** Perf logging: final frames since the image last restarted. */
  private perfRun: { start: number; frames: number; gpu: number } | null = null;
  /** Perf logging: the last splat frame's inputs. */
  private perfSplatInputs = "";

  private constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    renderer: Renderer,
    camera: Camera,
    transferFunction: TransferFunction,
    streamingManager: StreamingManager,
    dataProvider: DataProvider,
    metadata: VolumeMetadata,
    config: DatasetConfig,
  ) {
    this.device = device;
    this.canvas = canvas;
    this.context = context;
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    // The newest viewer on a canvas owns it: a previous one being disposed
    // (or still finishing its create) never reconfigures it.
    canvasOwner.set(canvas, this);
    context.configure({ device, format: this.canvasFormat });
    this.renderer = renderer;
    this.camera = camera;
    this.transferFunction = transferFunction;
    this.streamingManager = streamingManager;
    this.dataProvider = dataProvider;
    this.metadata = metadata;
    this.config = config;

    this.renderer.onDirty = () => {
      this.dirty = true;
    };

    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(
        () => this.resize(),
        100,
      ) as unknown as number;
    });
    this.resizeObserver.observe(canvas);
    this.resize();

    this.rafHandle = requestAnimationFrame(() => this.frame());
  }

  /**
   * Create a fully initialised KilnViewer for a data provider (from a URL:
   * `openDataset(url)`).
   */
  static async create(
    canvas: HTMLCanvasElement,
    dataProvider: DataProvider,
    options: ViewerOptions = {},
  ): Promise<KilnViewer> {
    // WebGPU init
    const adapter = await navigator.gpu?.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw new Error("WebGPU not supported");

    let device = await requestKilnDevice(adapter);

    const format = navigator.gpu.getPreferredCanvasFormat();
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Failed to get WebGPU canvas context");
    // Configured by the constructor, once nothing can be awaited any more.

    // Metadata. 16-bit data lives in r16float atlases (a core, filterable
    // format); built-in providers convert into it.
    const metadata = await dataProvider.initialize();
    const effectiveBitDepth = metadata.bitDepth;
    const textureFormat = effectiveBitDepth === 16 ? "r16float" : "r8unorm";
    if ("setTargetFormat" in dataProvider) {
      await (
        dataProvider as {
          setTargetFormat(f: typeof textureFormat): void | Promise<void>;
        }
      ).setTargetFormat(textureFormat);
    }

    // Build DatasetConfig
    const config = new DatasetConfig(
      metadata.dimensions,
      metadata.voxelSpacing,
    );

    // Atlas grid: adapter-class budget (unless the caller set one), then shrink
    // if allocation fails or the device is lost — the only hard VRAM signal.
    const bytesPerVoxel = textureFormat === "r8unorm" ? 1 : 2;
    const hints = adapterMemoryHints(adapter, readDeviceMemoryGiB());
    const budgetBytes =
      options.atlasBudgetBytes ?? guessAtlasBudgetBytes(hints);
    let { gridSize, atlasSize } = computeAtlasGrid(
      metadata.numChannels,
      bytesPerVoxel,
      budgetBytes,
    );
    const storedCap = readStoredAtlasGridCap();
    if (storedCap !== undefined && storedCap < gridSize) {
      gridSize = storedCap;
      atlasSize = gridSize * PHYSICAL_BRICK_SIZE;
    }
    const created = await createVolumeResourcesFittingDevice(
      adapter,
      device,
      effectiveBitDepth,
      textureFormat,
      config,
      metadata.numChannels,
      gridSize,
    );
    device = created.device;
    const resources = created.resources;
    gridSize = created.gridSize;
    atlasSize = gridSize * PHYSICAL_BRICK_SIZE;
    const atlasVramMB = Math.round(
      (metadata.numChannels * atlasSize ** 3 * bytesPerVoxel) / 1e6,
    );
    console.log(
      `[Kiln] atlas grid ${gridSize}³ (${atlasSize}³ voxels) × ${metadata.numChannels} channel(s) ≈ ${atlasVramMB} MB VRAM` +
        ` (budget ${(budgetBytes / 1e6).toFixed(0)} MB` +
        `${hints.isFallbackAdapter ? ", fallback adapter" : ""}` +
        `${hints.deviceMemoryGiB !== undefined ? `, deviceMemory=${hints.deviceMemoryGiB} GiB` : ""})`,
    );
    const renderer = new Renderer(device, format, resources, config);

    // Apply 16-bit window/level defaults from metadata
    if (effectiveBitDepth === 16) {
      if (metadata.window) {
        const { start, end, min, max } = metadata.window;
        const range = max - min;
        if (range > 0) {
          renderer.windowCenter = Math.max(
            0,
            Math.min(1, ((start + end) / 2 - min) / range),
          );
          renderer.windowWidth = Math.max(
            0.01,
            Math.min(1, (end - start) / range),
          );
        }
      } else {
        renderer.windowCenter = 0.5;
        renderer.windowWidth = 1.0;
      }
    }

    // Apply per-channel window/level from metadata. Float windows are
    // relative to the global dataRange (not per-channel OMERO min/max).
    if (metadata.channelWindows && metadata.numChannels > 1) {
      const dataRange =
        (metadata.isFloat ?? false) ? metadata.dataRange : undefined;
      for (let ch = 0; ch < metadata.channelWindows.length; ch++) {
        const w = metadata.channelWindows[ch];
        if (!w) continue;
        const lo = dataRange ? dataRange[0] : w.min;
        const hi = dataRange ? dataRange[1] : w.max;
        setChannelWindowFromRange(renderer, ch, w, lo, hi);
      }
    }

    // Default channel colours from the file (e.g. Imaris DataSetInfo).
    if (metadata.channelColors) {
      metadata.channelColors.forEach(([r, g, b], ch) => {
        if (ch < metadata.numChannels) renderer.setChannelColor(ch, r, g, b, 1);
      });
    }

    // Pass float32 data range to renderer for GPU normalization.
    if (metadata.isFloat && metadata.dataRange) {
      renderer.floatMin = metadata.dataRange[0];
      renderer.floatMax = metadata.dataRange[1];
    }

    const transferFunction = new TransferFunction(device);
    renderer.setTransferFunction(transferFunction);

    const camera = new Camera(canvas);

    // Apply ViewerOptions overrides
    if (options.mode !== undefined) {
      renderer.volumeRenderMode = options.mode;
      renderer.resetAccumulation();
    }
    if (options.windowCenter !== undefined) {
      renderer.windowCenter = options.windowCenter;
      renderer.resetAccumulation();
    }
    if (options.windowWidth !== undefined) {
      renderer.windowWidth = options.windowWidth;
      renderer.resetAccumulation();
    }
    if (options.densityScale !== undefined) {
      renderer.densityScale = options.densityScale;
      renderer.resetAccumulation();
    }
    if (options.depthCue !== undefined) {
      renderer.depthCue = Math.max(0, Math.min(1, options.depthCue));
      renderer.resetAccumulation();
    }
    if (options.isoValue !== undefined) {
      renderer.isoValue = options.isoValue;
      renderer.resetAccumulation();
    }
    if (options.clipMin !== undefined) {
      renderer.clipMin.set(options.clipMin);
      renderer.resetAccumulation();
    }
    if (options.clipMax !== undefined) {
      renderer.clipMax.set(options.clipMax);
      renderer.resetAccumulation();
    }
    if (options.tfPreset !== undefined) {
      transferFunction.setPreset(options.tfPreset);
      renderer.resetAccumulation();
    }
    if (options.tfPoints !== undefined) {
      transferFunction.setOpacityPoints(options.tfPoints);
      renderer.resetAccumulation();
    }
    if (options.sliceX !== undefined) renderer.sliceX = options.sliceX;
    if (options.sliceY !== undefined) renderer.sliceY = options.sliceY;
    if (options.sliceZ !== undefined) renderer.sliceZ = options.sliceZ;
    if (options.showSliceX !== undefined)
      renderer.showSliceX = options.showSliceX;
    if (options.showSliceY !== undefined)
      renderer.showSliceY = options.showSliceY;
    if (options.showSliceZ !== undefined)
      renderer.showSliceZ = options.showSliceZ;
    if (options.showWireframe !== undefined)
      renderer.showWireframe = options.showWireframe;
    if (options.showAxis !== undefined) renderer.showAxis = options.showAxis;
    if (options.upAxis !== undefined) {
      camera.setUpAxis(options.upAxis);
    }
    if (options.cam !== undefined) {
      camera.setOrbitState(options.cam);
    }

    // Streaming manager
    const streamingManager = new StreamingManager(
      resources,
      dataProvider,
      metadata,
      config,
      () => renderer.resetAccumulation(),
      options.pageLoadStart,
    );

    if (options.maxPixelError !== undefined) {
      streamingManager.maxPixelError = options.maxPixelError;
    }
    if (options.forcedLod !== undefined && options.forcedLod !== null) {
      const maxLod = metadata.maxLod;
      streamingManager.forcedLod = Math.max(
        0,
        Math.min(maxLod, Math.round(options.forcedLod)),
      );
    }

    const viewer = new KilnViewer(
      device,
      canvas,
      context,
      renderer,
      camera,
      transferFunction,
      streamingManager,
      dataProvider,
      metadata,
      config,
    );
    if (options.pixelRatio !== undefined)
      viewer.pixelRatio = options.pixelRatio;
    streamingManager.clipBox = { min: renderer.clipMin, max: renderer.clipMax };

    // When base LOD derives float/channel ranges, update renderer + metadata.
    // Wired after construction so onChannelWindowsChanged can notify external UI.
    streamingManager.setRangesDerivedCallback((opts) => {
      if (opts.dataRange) {
        renderer.floatMin = opts.dataRange[0];
        renderer.floatMax = opts.dataRange[1];
        renderer.resetAccumulation();
      }
      if (opts.channelRanges && metadata.channelWindows) {
        for (let ch = 0; ch < opts.channelRanges.length; ch++) {
          const w = metadata.channelWindows[ch];
          if (w) setChannelWindowFromRange(renderer, ch, w, w.min, w.max);
        }
        renderer.resetAccumulation();
      }
      viewer.onChannelWindowsChanged?.();
    });

    const atlasGridSize = gridSize;
    device.lost.then((info) => {
      if (info.reason === "destroyed") return;
      console.warn(`[Kiln] GPU device lost (${info.reason}): ${info.message}`);
      const next = nextSmallerAtlasGrid(atlasGridSize);
      if (next !== null) storeAtlasGridCap(next);
      viewer.dispose();
    });

    return viewer;
  }

  // Render state convenience API
  get mode(): VolumeRenderMode {
    return this.renderer.volumeRenderMode;
  }
  set mode(value: VolumeRenderMode) {
    this.renderer.volumeRenderMode = value;
    this.renderer.resetAccumulation();
  }

  get isoValue(): number {
    return this.renderer.isoValue;
  }
  set isoValue(value: number) {
    this.renderer.isoValue = value;
    this.renderer.resetAccumulation();
  }

  get windowCenter(): number {
    return this.renderer.windowCenter;
  }
  set windowCenter(value: number) {
    this.renderer.windowCenter = value;
    this.renderer.resetAccumulation();
  }

  get windowWidth(): number {
    return this.renderer.windowWidth;
  }
  set windowWidth(value: number) {
    this.renderer.windowWidth = value;
    this.renderer.resetAccumulation();
  }

  /** Minimum raw float value that maps to 0.0 in the shader (float32 datasets only). */
  get floatMin(): number {
    return this.renderer.floatMin;
  }
  set floatMin(value: number) {
    this.renderer.floatMin = value;
    this.renderer.resetAccumulation();
  }

  /** Maximum raw float value that maps to 1.0 in the shader (float32 datasets only). */
  get floatMax(): number {
    return this.renderer.floatMax;
  }
  set floatMax(value: number) {
    this.renderer.floatMax = value;
    this.renderer.resetAccumulation();
  }

  /** Canvas pixels per CSS pixel (see {@link ViewerOptions.pixelRatio}). */
  get pixelRatio(): number {
    return this.pixelRatio_;
  }
  set pixelRatio(value: number) {
    const next = Math.max(0.25, Math.min(4, value || 1));
    if (next === this.pixelRatio_) return;
    this.pixelRatio_ = next;
    this.streamingManager.pixelRatio = next;
    this.resize();
    this.streamingManager.forceUpdate(this.camera, this.canvas);
  }

  /**
   * Depth cue strength, 0 (off) to 1: colour fades with distance from the
   * camera, so structures behind others read as farther away instead of
   * stacking up to the same brightness. Applies to the volume (across the
   * clip box; MIP fades before taking the maximum) and the splats (across
   * the whole volume). Splat training captures without it.
   */
  get depthCue(): number {
    return this.renderer.depthCue;
  }
  set depthCue(value: number) {
    const next = Math.max(0, Math.min(1, value || 0));
    if (next === this.renderer.depthCue) return;
    this.renderer.depthCue = next;
    this.renderer.resetAccumulation();
    this.dirty = true;
  }

  /** Depth cue for the splats: across the whole volume (they aren't clipped). */
  private splatDepthCue(): DepthCue {
    const h = this.config.normalizedSize.map((s) => s / 2);
    return depthCueFor(
      this.camera.position,
      h.map((v) => -v),
      h,
      this.renderer.depthCue,
    );
  }

  /** Forced stream LOD (`null` = automatic SSE). 0 = finest. */
  get forcedLod(): number | null {
    return this.streamingManager.forcedLod;
  }
  set forcedLod(value: number | null) {
    if (value === null) {
      this.streamingManager.forcedLod = null;
    } else {
      const maxLod = this.metadata.maxLod;
      this.streamingManager.forcedLod = Math.max(
        0,
        Math.min(maxLod, Math.round(value)),
      );
    }
    this.streamingManager.forceUpdate(this.camera, this.canvas);
    this.dirty = true;
  }

  /** Finest LOD currently desired/resident (for seeding the manual LOD slider). */
  get finestStreamLod(): number {
    return this.streamingManager.getFinestStreamLod();
  }

  // State serialisation
  getState(): ViewerState {
    const [rx, ry, dist, tx, ty, tz] = this.camera.getOrbitState();
    return {
      mode: this.renderer.volumeRenderMode,
      windowCenter: this.renderer.windowCenter,
      windowWidth: this.renderer.windowWidth,
      densityScale: this.renderer.densityScale,
      isoValue: this.renderer.isoValue,
      forcedLod: this.streamingManager.forcedLod,
      tfPreset: this.transferFunction.preset,
      tfPoints: this.transferFunction.getOpacityPoints(),
      upAxis: this.camera.getUpAxis(),
      cam: [rx, ry, dist, tx, ty, tz],
      clipMin: [
        this.renderer.clipMin[0] ?? 0,
        this.renderer.clipMin[1] ?? 0,
        this.renderer.clipMin[2] ?? 0,
      ],
      clipMax: [
        this.renderer.clipMax[0] ?? 1,
        this.renderer.clipMax[1] ?? 1,
        this.renderer.clipMax[2] ?? 1,
      ],
      sliceX: this.renderer.sliceX,
      sliceY: this.renderer.sliceY,
      sliceZ: this.renderer.sliceZ,
      showSliceX: this.renderer.showSliceX,
      showSliceY: this.renderer.showSliceY,
      showSliceZ: this.renderer.showSliceZ,
      showWireframe: this.renderer.showWireframe,
      showAxis: this.renderer.showAxis,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.splatLayer?.destroy();
    cancelAnimationFrame(this.rafHandle);
    clearTimeout(this.resizeTimer);
    this.resizeObserver.disconnect();
    this.renderer.resources.destroy();
    try {
      this.device.destroy();
    } catch {
      /* already lost */
    }
    this.dataProvider.dispose();
    if (canvasOwner.get(this.canvas) === this) {
      canvasOwner.delete(this.canvas);
      this.context.unconfigure();
    }
  }

  /** Pause / resume the RAF loop (used while capturing splat datasets). */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused && !this.disposed) {
      this.dirty = true;
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = requestAnimationFrame(() => this.frame());
    }
  }

  // ── Gaussian splats ────────────────────────────────────────────────────────

  /** The splat layer (created on first use). */
  get splats(): SplatLayer {
    if (!this.splatLayer) {
      this.splatLayer = new SplatLayer(this.device, this.canvasFormat);
    }
    return this.splatLayer;
  }

  /** Number of splats currently loaded (0 when none). */
  get splatCount(): number {
    return this.splatLayer?.gaussianCount ?? 0;
  }

  get displayMode(): DisplayMode {
    return this.displayMode_;
  }
  set displayMode(mode: DisplayMode) {
    this.displayMode_ = mode;
    this.renderer.resetAccumulation();
    this.dirty = true;
  }

  /** Split divider position, 0–1 of the canvas width. */
  get splitFraction(): number {
    return this.splitFraction_;
  }
  set splitFraction(v: number) {
    this.splitFraction_ = Math.min(1, Math.max(0, v));
    this.dirty = true;
  }

  /** Show a Gaussian cloud (from `generateSplats`, `readPly`, …). */
  setSplats(cloud: GaussianCloud | null): void {
    this.splats.setCloud(cloud);
    this.dirty = true;
  }

  /** Load a 3DGS .ply (binary little-endian) and show it. */
  loadSplatPly(bytes: Uint8Array | ArrayBuffer): GaussianCloud {
    const cloud = readPly(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    this.setSplats(cloud);
    return cloud;
  }

  /** Current splats as a 3DGS .ply, or null if none. */
  exportSplatPly(): Uint8Array | null {
    const cloud = this.splatLayer?.cloud;
    return cloud ? writePly(cloud) : null;
  }

  private buildHost(): SplatBuildHost {
    return {
      device: this.device,
      renderer: this.renderer,
      camera: this.camera,
      streaming: this.streamingManager,
      provider: this.dataProvider,
      metadata: this.metadata,
      config: this.config,
      transferFunction: this.transferFunction,
      canvas: this.canvas,
      presentView: () => this.context.getCurrentTexture().createView(),
    };
  }

  /**
   * Turn the volume — with its current channels, colours, windows and
   * transfer function, in `renderMode` at `density` inside `region` (each
   * defaulting to what is displayed) — into Gaussian splats: a direct
   * moment-matched fit from the voxels, optionally refined with Brush against
   * renders of the same volume. The viewer's render state is restored after;
   * the result is shown and returned.
   */
  async generateSplats(
    opts: GenerateSplatsOptions = {},
  ): Promise<GaussianCloud> {
    if (this.building) throw new Error("A splat build is already running");
    this.building = true;
    const r = this.renderer;
    const saved = {
      mode: r.volumeRenderMode,
      density: r.densityScale,
      clipMin: Float32Array.from(r.clipMin),
      clipMax: Float32Array.from(r.clipMax),
      forcedLod: this.forcedLod,
      display: this.displayMode_,
      pixelRatio: this.streamingManager.pixelRatio,
      colors: Float32Array.from(r.channelColors),
    };
    const mode =
      opts.renderMode ??
      (saved.mode === "mip" || saved.mode === "iso" ? saved.mode : "dvr");
    const region: Box = opts.region ?? {
      min: [saved.clipMin[0]!, saved.clipMin[1]!, saved.clipMin[2]!],
      max: [saved.clipMax[0]!, saved.clipMax[1]!, saved.clipMax[2]!],
    };
    try {
      if (r.volumeRenderMode !== mode) this.mode = mode;
      r.densityScale =
        mode === "mip" ? MIP_FIT_DENSITY : (opts.density ?? saved.density);
      this.displayMode_ = "volume";
      this.forcedLod = null; // build at screen-matched detail
      // Captures render at their own size: detail follows capture pixels.
      this.streamingManager.pixelRatio = 1;
      const boxes = tileBoxes(
        chooseTiles(this.config.normalizedSize, opts.tileSplits ?? 0),
        region,
      );
      // Channel slots to build one by one (null: all together, as displayed).
      const channels: Array<number | null> = [];
      if (opts.perChannel && r.numChannels > 1) {
        for (let ch = 0; ch < r.numChannels; ch++)
          if ((saved.colors[ch * 4 + 3] ?? 0) > 0) channels.push(ch);
      }
      if (channels.length === 0) channels.push(null);
      const targetCount = Math.ceil(
        (opts.targetCount ?? 1_000_000) / (boxes.length * channels.length),
      );
      // Caller cameras frame the whole region; a tile's cloud covers part of it.
      const buildOpts: SplatBuildOptions =
        boxes.length === 1
          ? opts
          : { ...opts, extraViews: undefined, evaluateAt: undefined };
      const steps = boxes.length * channels.length;
      let step = 0;
      const built: GaussianCloud[] = [];
      for (const ch of channels) {
        if (ch !== null) {
          // This channel alone, in white: colour is applied at display.
          r.channelColors.fill(0);
          r.channelColors.set([1, 1, 1, 1], ch * 4);
        }
        const parts: Array<GaussianCloud & { core: Box }> = [];
        for (const box of boxes) {
          opts.onTile?.(step++, steps);
          r.clipMin.set(box.train.min);
          r.clipMax.set(box.train.max);
          r.resetAccumulation();
          const cloud = await this.buildSplats({ ...buildOpts, targetCount });
          parts.push({ ...cloud, core: box.core });
        }
        const first = parts[0]!;
        let cloud: GaussianCloud = first;
        if (parts.length > 1) {
          const merged = mergeTileParams(parts, this.config.normalizedSize);
          cloud = cloudFromParams(merged.params, merged.count, {
            worldScale: first.worldScale,
            worldUnit: first.worldUnit,
          });
        }
        built.push(cloud);
      }
      const cloud =
        channels[0] === null
          ? built[0]!
          : mergeClouds(
              built,
              channels as number[],
              mode === "mip" ? "add" : "over",
            );
      this.setSplats(cloud);
      return cloud;
    } finally {
      r.channelColors.set(saved.colors);
      r.clipMin.set(saved.clipMin);
      r.clipMax.set(saved.clipMax);
      r.densityScale = saved.density;
      if (r.volumeRenderMode !== saved.mode) this.mode = saved.mode;
      this.forcedLod = saved.forcedLod;
      this.streamingManager.pixelRatio = saved.pixelRatio;
      this.displayMode_ = saved.display;
      r.resetAccumulation();
      this.building = false;
    }
  }

  /** Fit (+ train, + evaluate) the region inside the current clip box. */
  private async buildSplats(opts: SplatBuildOptions): Promise<GaussianCloud> {
    const host = this.buildHost();
    let views: CapturedViews | null = null;
    let evalViews: CapturedViews | null = null;
    try {
      let cloud = await fitVolume(host, opts);
      this.setSplats(cloud);
      const train = opts.train !== false && cloud.count > 0;
      const nEval = cloud.count > 0 ? (opts.evaluateViews ?? 0) : 0;
      const scoreAt = cloud.count > 0 ? (opts.evaluateAt ?? []) : [];
      this.setPaused(true);
      if (train) views = await captureViews(host, opts);
      const evalOpts: SplatBuildOptions = {
        ...opts,
        views: nEval,
        viewSeed: 7919,
        onProgress: (p) =>
          opts.onProgress?.({
            ...p,
            label: `Held-out ${p.label.toLowerCase()}`,
          }),
      };
      if (scoreAt.length > 0) {
        evalViews = await captureViewsAt(host, scoreAt, evalOpts);
      } else if (nEval > 0) {
        evalViews = await captureViews(host, evalOpts);
      }
      if (views) {
        cloud = await trainCloud(host, cloud, views, opts);
        this.setSplats(cloud);
      }
      // setSplats uploaded the cloud: evaluate that buffer.
      const params = this.splats.paramsBuffer;
      const measured =
        evalViews && params
          ? await evaluateCloud(
              this.device,
              params,
              cloud.count,
              evalViews,
              this.renderer.background,
            )
          : undefined;
      // Reported only when it is a number (callers store it as one).
      const psnr = Number.isFinite(measured) ? measured : undefined;
      opts.onProgress?.({
        stage: "done",
        fraction: 1,
        label:
          `${cloud.count.toLocaleString()} Gaussians` +
          (psnr !== undefined ? ` · ${psnr.toFixed(1)} dB PSNR vs volume` : ""),
        gaussians: cloud.count,
        psnr,
      });
      return cloud;
    } finally {
      views?.texture.destroy();
      evalViews?.texture.destroy();
      this.setPaused(false);
      this.dirty = true;
    }
  }

  /** Render one frame immediately (used for previews while paused). */
  renderNow(): void {
    this.renderFrame();
  }

  private resize(): void {
    const maxDim = this.device.limits.maxTextureDimension2D;
    const r = this.pixelRatio_;
    const width = Math.max(
      1,
      Math.min(Math.round(this.canvas.clientWidth * r), maxDim),
    );
    const height = Math.max(
      1,
      Math.min(Math.round(this.canvas.clientHeight * r), maxDim),
    );
    // Compared with the renderer (not the canvas element): a new viewer on a
    // canvas that already has the right size still sizes its renderer.
    if (this.renderer.width !== width || this.renderer.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.renderer.resize(width, height);
      this.renderer.prepareScale(1);
      this.renderer.prepareScale(DRAFT_SCALE);
      this.dirty = true;
    }
  }

  private frame(): void {
    if (this.disposed || canvasOwner.get(this.canvas) !== this) return;
    if (this.paused) {
      this.rafHandle = requestAnimationFrame(() => this.frame());
      return;
    }

    const now = performance.now();
    if (this.camera.version !== this.lastCameraVersion) {
      if (perfOn && now - this.lastCameraChange >= DRAFT_AFTER_MOVE_MS) {
        this.perfMove ??= now;
      }
      this.lastCameraVersion = this.camera.version;
      this.lastCameraChange = now;
      this.dirty = true;
    }

    // Always run streaming (may trigger onDirty via resetAccumulation)
    this.streamingManager.update(this.camera, this.canvas);

    const splatVersion = this.splatLayer?.version ?? -1;
    if (splatVersion !== this.lastSplatVersion) {
      this.lastSplatVersion = splatVersion;
      this.dirty = true;
    }

    // Draft frames — half resolution, short accumulation — while the camera
    // moves or bricks stream in. A zoomed-in multichannel frame can cost
    // hundreds of ms of GPU time at full resolution, and the stream keeps
    // restarting accumulation.
    const draft =
      this.camera.isInteracting() ||
      now - this.lastCameraChange < DRAFT_AFTER_MOVE_MS ||
      this.streamingManager.isLoading;
    const scale = draft ? DRAFT_SCALE : 1;
    if (this.renderer.renderScale !== scale) {
      this.renderer.activateScale(scale);
      this.dirty = true;
    }
    this.renderer.maxAccumFrames = draft
      ? DRAFT_ACCUM_FRAMES
      : FINAL_ACCUM_FRAMES;
    this.renderer.stepScale = draft ? DRAFT_STEP_SCALE : 1;

    // Determine if we need to render
    const volumeVisible = this.displayMode_ !== "splats";
    const needsRender =
      this.dirty || (volumeVisible && !this.renderer.isConverged);

    // At most one frame on the GPU: queued-up ray-march dispatches can't be
    // pre-empted and stall the browser's own compositing.
    if (needsRender && !this.gpuBusy) {
      this.dirty = false;
      this.onBeforeFrame?.();
      const perf = perfOn ? this.perfFrameStart(draft) : null;
      this.renderFrame();
      this.gpuBusy = true;
      const idle = () => {
        this.gpuBusy = false;
        if (perf) this.perfFrameDone(perf);
      };
      this.device.queue.onSubmittedWorkDone().then(idle, idle);
    }

    this.rafHandle = requestAnimationFrame(() => this.frame());
  }

  /** Perf logging: what a frame about to render is. */
  private perfFrameStart(draft: boolean): PerfFrame {
    const r = this.renderer;
    const move = this.perfMove;
    this.perfMove = null;
    const splats = this.displayMode_ === "splats" && this.splatCount > 0;
    if (splats) {
      const inputs = [
        this.camera.version,
        this.canvas.width,
        this.canvas.height,
        this.splatLayer?.version,
        r.depthCue,
        ...r.channelColors,
      ].join();
      perfCount(
        inputs === this.perfSplatInputs
          ? "splat frames, inputs unchanged"
          : "splat frames",
      );
      this.perfSplatInputs = inputs;
    }
    let shown = 0;
    for (let ch = 0; ch < r.numChannels; ch++) {
      if ((r.channelColors[ch * 4 + 3] ?? 0) > 0) shown++;
    }
    return {
      start: performance.now(),
      move,
      label: splats
        ? "splats"
        : `${draft ? "draft" : "final"} ${r.volumeRenderMode} ×${r.renderScale} ${shown}ch`,
      final: !splats && !draft,
      accumulated: r.accumulatedFrames,
    };
  }

  /**
   * Perf logging: a frame finished on the GPU (submit to done, which also
   * covers the browser's own GPU work queued meanwhile).
   */
  private perfFrameDone(f: PerfFrame): void {
    const now = performance.now();
    const gpu = now - f.start;
    perfSample(`${f.label} frame GPU`, gpu);
    if (f.move !== null) {
      perfSample("camera move → first frame done", now - f.move);
    }
    // Final frames from a restart (accumulated 0) until converged.
    if (this.perfRun && (!f.final || f.accumulated === 0)) {
      perfCount("final images restarted before converging");
      perfSample("GPU spent on restarted final images", this.perfRun.gpu);
      this.perfRun = null;
    }
    if (!f.final) return;
    const run = this.perfRun ?? { start: f.start, frames: 0, gpu: 0 };
    this.perfRun = run;
    run.frames++;
    run.gpu += gpu;
    if (this.renderer.isConverged) {
      perfEvent(
        `converged: ${run.frames} final frames, ${ms(now - run.start)} wall, ${ms(run.gpu)} GPU (${f.label}, ${this.canvas.width}×${this.canvas.height})`,
      );
      this.perfRun = null;
    }
  }

  private renderFrame(): void {
    const view = this.context.getCurrentTexture().createView();
    const mode = this.displayMode_;
    const hasSplats = (this.splatLayer?.gaussianCount ?? 0) > 0;
    if (mode === "volume" || !hasSplats) {
      this.renderer.render(view, this.camera);
      return;
    }
    const bg = this.renderer.background;
    if (mode === "splats") {
      this.splats.render(
        view,
        this.camera,
        this.canvas.width,
        this.canvas.height,
        {
          background: bg,
          channelColors: this.renderer.channelColors,
          depthCue: this.splatDepthCue(),
        },
      );
      return;
    }
    // split: volume everywhere, splats right of the divider
    this.renderer.render(view, this.camera);
    this.splats.render(
      view,
      this.camera,
      this.canvas.width,
      this.canvas.height,
      {
        background: bg,
        splitX: Math.round(this.splitFraction_ * this.canvas.width),
        clear: false,
        channelColors: this.renderer.channelColors,
        depthCue: this.splatDepthCue(),
      },
    );
  }
}
