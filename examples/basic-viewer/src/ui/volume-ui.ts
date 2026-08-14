/**
 * Volume Renderer UI Controls — dependency-free (Phase 3 of the interface
 * redesign; Tweakpane removed from user-facing UI entirely).
 */

import type { Camera, UpAxis } from "@kiln/core/camera.js";
import { computeHistogram } from "@kiln/core/histogram.js";
import type { Renderer, VolumeRenderMode } from "@kiln/core/renderer.js";
// @kiln/* is a dev-only path alias (src/ → @kiln/) defined in vite.config.ts and
// tsconfig.json. It gives the example direct access to internal library types that
// are not part of the public API.
import type {
  TFPreset,
  TransferFunction,
} from "@kiln/core/transfer-function.js";
import type { VolumeMetadata } from "@kiln/data/data-provider.js";
import type { StreamingManager } from "@kiln/streaming/streaming-manager.js";
import type { KilnViewer } from "kiln-render";
import { trackRenderMode } from "../../../shared/analytics.js";
import {
  createCollapsible,
  createPanel,
  createRangeSlider,
  createSegmentedControl,
  createSelect,
  createSlider,
  createSliderToggleRow,
  createSwapRegion,
  createToggle,
} from "../../../shared/controls/widgets.js";
import { StatsPanel } from "../../../shared/stats-panel.js";

/** Only 'dvr' | 'mip' | 'iso' | 'slice' are selectable via the Mode segmented control. */
type BaseRenderMode = "dvr" | "mip" | "iso" | "slice";

export class VolumeUI {
  private viewer: KilnViewer;
  private stats: StatsPanel;
  private renderer: Renderer;
  private camera: Camera;
  private transferFunction: TransferFunction;
  private metadata: VolumeMetadata | null = null;

  private tfCanvas: HTMLCanvasElement;
  private isDraggingPoint = false;
  private dragPointIndex = -1;

  private params = {
    renderMode: "dvr" as BaseRenderMode,
    isoValue: 0.2,
    tfPreset: "grayscale" as TFPreset,
    upAxis: "-y" as UpAxis,
    useIndirection: true,
    showWireframe: false,
    showAxis: false,
    windowCenter: 0.5,
    windowWidth: 1.0,
    densityScale: 1.0,
    renderScale: 0.5,
    /** Manual Data LOD override (toggle off = Auto SSE) */
    dataLodManual: false,
    dataLod: 0,
    enableJitter: true,
    enableTAA: true,
    clipX: { min: 0.0, max: 1.0 },
    clipY: { min: 0.0, max: 1.0 },
    clipZ: { min: 0.0, max: 1.0 },
    showSliceX: true,
    sliceX: 0.5,
    showSliceY: true,
    sliceY: 0.5,
    showSliceZ: true,
    sliceZ: 0.5,
  };

  // Widget accessors, kept for syncFromState()
  private modeControl!: ReturnType<typeof createSegmentedControl>;
  private modeSwap!: ReturnType<typeof createSwapRegion>;
  private tfPresetSelect!: ReturnType<typeof createSelect>;
  private isoValueSlider!: ReturnType<typeof createSlider>;
  private windowCenterSlider!: ReturnType<typeof createSlider>;
  private windowWidthSlider!: ReturnType<typeof createSlider>;
  private densitySlider!: ReturnType<typeof createSlider>;
  private sliceRows!: [
    ReturnType<typeof createSliderToggleRow>,
    ReturnType<typeof createSliderToggleRow>,
    ReturnType<typeof createSliderToggleRow>,
  ];
  private upAxisSelect!: ReturnType<typeof createSelect>;
  private wireframeToggle!: ReturnType<typeof createToggle>;
  private axesToggle!: ReturnType<typeof createToggle>;
  private clipSliders!: [
    ReturnType<typeof createRangeSlider>,
    ReturnType<typeof createRangeSlider>,
    ReturnType<typeof createRangeSlider>,
  ];
  private clipSection!: HTMLElement;
  private renderScaleSlider!: ReturnType<typeof createSlider>;
  private dataLodSlider!: ReturnType<typeof createSlider>;
  private jitterToggle!: ReturnType<typeof createToggle>;
  private taaToggle!: ReturnType<typeof createToggle>;
  private indirectionToggle!: ReturnType<typeof createToggle>;
  private tfPresetEl!: HTMLElement;
  private tfCanvasContainer!: HTMLElement;

  constructor(viewer: KilnViewer) {
    this.viewer = viewer;
    this.renderer = viewer.renderer;
    this.camera = viewer.camera;
    this.transferFunction = viewer.transferFunction;

    // Initialize slice/clip params in absolute dataset coordinates
    const dims = viewer.metadata.dimensions;
    this.params.sliceX = Math.round(dims[0] / 2);
    this.params.sliceY = Math.round(dims[1] / 2);
    this.params.sliceZ = Math.round(dims[2] / 2);
    this.params.clipX = { min: 0, max: dims[0] };
    this.params.clipY = { min: 0, max: dims[1] };
    this.params.clipZ = { min: 0, max: dims[2] };

    // Sync initial values from camera/renderer
    this.params.renderMode = this.normalizeMode(this.renderer.volumeRenderMode);
    if (this.renderer.volumeRenderMode !== this.params.renderMode) {
      this.renderer.volumeRenderMode = this.params.renderMode;
    }
    this.params.upAxis = this.camera.getUpAxis();
    this.params.useIndirection = this.renderer.useIndirection;
    this.params.showWireframe = this.renderer.showWireframe;
    this.params.showAxis = this.renderer.showAxis;
    this.params.windowCenter = this.renderer.windowCenter;
    this.params.windowWidth = this.renderer.windowWidth;
    this.params.renderScale = this.renderer.renderScale;
    const initialForced = this.viewer.forcedLod;
    this.params.dataLodManual = initialForced !== null;
    this.params.dataLod = initialForced ?? this.viewer.finestStreamLod;

    const controlsContainer = document.createElement("div");
    controlsContainer.style.cssText =
      "position: fixed; left: 8px; top: 44px; z-index: 1000;";
    document.body.appendChild(controlsContainer);

    const statsContainer = document.createElement("div");
    statsContainer.style.cssText =
      "position: fixed; right: 8px; bottom: calc(36px + env(safe-area-inset-bottom, 0px)); z-index: 1000;";
    document.body.appendChild(statsContainer);
    this.stats = new StatsPanel(statsContainer);

    this.tfCanvas = document.createElement("canvas");
    this.tfCanvas.width = 256;
    this.tfCanvas.height = 80;
    this.tfCanvas.className = "ctl-tf-canvas";

    this.buildPanel(controlsContainer);
    this.setupTFCanvasEvents();
    this.updateTFPreview();
    this.updateVisibility();
    this.initStreaming(viewer.streamingManager, viewer.metadata);
  }

  private normalizeMode(mode: VolumeRenderMode): BaseRenderMode {
    if (mode === "lod") return "dvr";
    if (mode === "slice-lod") return "slice";
    if (
      mode === "dvr" ||
      mode === "mip" ||
      mode === "iso" ||
      mode === "slice"
    ) {
      return mode;
    }
    return "dvr";
  }

  private applyMode(): void {
    this.renderer.volumeRenderMode = this.params.renderMode;
    this.renderer.resetAccumulation();
    this.updateVisibility();
  }

  private buildPanel(container: HTMLElement): void {
    const { el: panelEl, body } = createPanel("Controls", {
      defaultCollapsed: false,
    });
    container.appendChild(panelEl);

    // --- Mode segmented control ---
    this.modeControl = createSegmentedControl({
      options: [
        { label: "DVR", value: "dvr" },
        { label: "MIP", value: "mip" },
        { label: "ISO", value: "iso" },
        { label: "Slice", value: "slice" },
      ],
      value: this.params.renderMode,
      onChange: (v) => {
        this.params.renderMode = v as BaseRenderMode;
        this.applyMode();
        trackRenderMode(v);
      },
    });
    body.appendChild(this.modeControl.el);

    this.mountLodControls(body);

    // --- Mode-options swap region (contents depend on base mode) ---
    this.modeSwap = createSwapRegion();
    body.appendChild(this.modeSwap.el);
    this.buildModeOptionsWidgets();

    // --- Scene section (mode-independent, collapsible, open by default) ---
    const { el: sceneEl, body: sceneSection } = createCollapsible(
      "Scene",
      true,
    );
    body.appendChild(sceneEl);

    this.upAxisSelect = createSelect({
      label: "Up Axis",
      options: [
        { label: "X", value: "x" },
        { label: "Y", value: "y" },
        { label: "Z", value: "z" },
        { label: "-X", value: "-x" },
        { label: "-Y", value: "-y" },
        { label: "-Z", value: "-z" },
      ],
      value: this.params.upAxis,
      onChange: (v) => {
        this.camera.setUpAxis(v as UpAxis);
        this.renderer.resetAccumulation();
      },
    });
    sceneSection.appendChild(this.upAxisSelect.el);

    this.wireframeToggle = createToggle({
      label: "Wireframe",
      value: this.params.showWireframe,
      onChange: (v) => {
        this.renderer.showWireframe = v;
        this.renderer.markDirty();
      },
    });
    sceneSection.appendChild(this.wireframeToggle.el);

    this.axesToggle = createToggle({
      label: "Axes",
      value: this.params.showAxis,
      onChange: (v) => {
        this.renderer.showAxis = v;
        this.renderer.markDirty();
      },
    });
    sceneSection.appendChild(this.axesToggle.el);

    this.clipSection = document.createElement("div");
    sceneSection.appendChild(this.clipSection);
    const clipDims = this.viewer.metadata.dimensions;
    const clipX = createRangeSlider({
      label: "Clip X",
      min: 0,
      max: clipDims[0],
      step: 1,
      valueMin: this.params.clipX.min,
      valueMax: this.params.clipX.max,
      format: (v) => v.toFixed(0),
      onChange: (min, max) => {
        this.renderer.clipMin[0] = min / clipDims[0];
        this.renderer.clipMax[0] = max / clipDims[0];
        this.renderer.resetAccumulation();
      },
    });
    const clipY = createRangeSlider({
      label: "Clip Y",
      min: 0,
      max: clipDims[1],
      step: 1,
      valueMin: this.params.clipY.min,
      valueMax: this.params.clipY.max,
      format: (v) => v.toFixed(0),
      onChange: (min, max) => {
        this.renderer.clipMin[1] = min / clipDims[1];
        this.renderer.clipMax[1] = max / clipDims[1];
        this.renderer.resetAccumulation();
      },
    });
    const clipZ = createRangeSlider({
      label: "Clip Z",
      min: 0,
      max: clipDims[2],
      step: 1,
      valueMin: this.params.clipZ.min,
      valueMax: this.params.clipZ.max,
      format: (v) => v.toFixed(0),
      onChange: (min, max) => {
        this.renderer.clipMin[2] = min / clipDims[2];
        this.renderer.clipMax[2] = max / clipDims[2];
        this.renderer.resetAccumulation();
      },
    });
    this.clipSliders = [clipX, clipY, clipZ];
    this.clipSection.appendChild(clipX.el);
    this.clipSection.appendChild(clipY.el);
    this.clipSection.appendChild(clipZ.el);

    // --- Advanced (collapsed by default) ---
    const { el: advancedEl, body: advancedBody } = createCollapsible(
      "Advanced",
      false,
    );
    body.appendChild(advancedEl);

    this.renderScaleSlider = createSlider({
      label: "Render Scale",
      min: 0.25,
      max: 1.0,
      step: 0.25,
      value: this.params.renderScale,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        this.viewer.renderScale = v;
      },
    });
    advancedBody.appendChild(this.renderScaleSlider.el);

    this.jitterToggle = createToggle({
      label: "Jitter",
      value: this.params.enableJitter,
      onChange: (v) => {
        this.renderer.enableJitter = v;
        this.renderer.resetAccumulation();
      },
    });
    advancedBody.appendChild(this.jitterToggle.el);

    this.taaToggle = createToggle({
      label: "TAA",
      value: this.params.enableTAA,
      onChange: (v) => {
        this.renderer.enableTAA = v;
        this.renderer.resetAccumulation();
      },
    });
    advancedBody.appendChild(this.taaToggle.el);

    this.indirectionToggle = createToggle({
      label: "Indirection",
      value: this.params.useIndirection,
      onChange: (v) => {
        this.renderer.useIndirection = v;
        this.renderer.resetAccumulation();
      },
    });
    advancedBody.appendChild(this.indirectionToggle.el);
  }

  /** Builds the persistent mode-options widgets once; updateVisibility() swaps which are shown. */
  private buildModeOptionsWidgets(): void {
    this.tfPresetSelect = createSelect({
      label: "Preset",
      options: [
        { label: "Cool-Warm", value: "coolwarm" },
        { label: "Grayscale", value: "grayscale" },
        { label: "Grayscale (inverted)", value: "grayscale-inverted" },
        { label: "Hot", value: "hot" },
        { label: "Cool", value: "cool" },
        { label: "Viridis", value: "viridis" },
        { label: "Plasma", value: "plasma" },
        { label: "Seismic", value: "seismic" },
      ],
      value: this.params.tfPreset,
      onChange: (v) => {
        this.transferFunction.setPreset(v as TFPreset);
        this.renderer.resetAccumulation();
        this.updateTFPreview();
      },
    });

    const helpText = document.createElement("div");
    helpText.className = "ctl-tf-help";
    helpText.textContent = "Click to add, drag to move, dbl-click to remove";

    this.isoValueSlider = createSlider({
      label: "ISO Value",
      min: 0,
      max: 1,
      step: 0.01,
      value: this.params.isoValue,
      onChange: (v) => {
        this.renderer.isoValue = v;
        this.renderer.resetAccumulation();
      },
    });

    this.windowCenterSlider = createSlider({
      label: "Center",
      min: 0,
      max: 1,
      step: 0.01,
      value: this.params.windowCenter,
      onChange: (v) => {
        this.renderer.windowCenter = v;
        this.renderer.resetAccumulation();
        this.updateTFPreview();
      },
    });

    this.windowWidthSlider = createSlider({
      label: "Width",
      min: 0.01,
      max: 1,
      step: 0.01,
      value: this.params.windowWidth,
      onChange: (v) => {
        this.renderer.windowWidth = v;
        this.renderer.resetAccumulation();
        this.updateTFPreview();
      },
    });

    this.densitySlider = createSlider({
      label: "Density",
      min: 0.1,
      max: 10.0,
      step: 0.1,
      value: this.params.densityScale,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        this.renderer.densityScale = v;
        this.renderer.resetAccumulation();
      },
    });

    const sliceDims = this.viewer.metadata.dimensions;
    const sliceX = createSliderToggleRow({
      label: "X",
      min: 0,
      max: sliceDims[0],
      step: 1,
      value: this.params.sliceX,
      checked: this.params.showSliceX,
      onValueChange: (v) => {
        this.renderer.sliceX = v / sliceDims[0];
        this.renderer.markDirty();
      },
      onCheckedChange: (v) => {
        this.renderer.showSliceX = v;
        this.renderer.markDirty();
      },
    });
    const sliceY = createSliderToggleRow({
      label: "Y",
      min: 0,
      max: sliceDims[1],
      step: 1,
      value: this.params.sliceY,
      checked: this.params.showSliceY,
      onValueChange: (v) => {
        this.renderer.sliceY = v / sliceDims[1];
        this.renderer.markDirty();
      },
      onCheckedChange: (v) => {
        this.renderer.showSliceY = v;
        this.renderer.markDirty();
      },
    });
    const sliceZ = createSliderToggleRow({
      label: "Z",
      min: 0,
      max: sliceDims[2],
      step: 1,
      value: this.params.sliceZ,
      checked: this.params.showSliceZ,
      onValueChange: (v) => {
        this.renderer.sliceZ = v / sliceDims[2];
        this.renderer.markDirty();
      },
      onCheckedChange: (v) => {
        this.renderer.showSliceZ = v;
        this.renderer.markDirty();
      },
    });
    this.sliceRows = [sliceX, sliceY, sliceZ];

    // Store the TF widget group for reuse across dvr/mip/slice
    this.tfPresetEl = this.tfPresetSelect.el;
    this.tfCanvasContainer = document.createElement("div");
    this.tfCanvasContainer.className = "ctl-tf-canvas-container";
    this.tfCanvasContainer.appendChild(this.tfCanvas);
    this.tfCanvasContainer.appendChild(helpText);
  }

  private initStreaming(
    manager: StreamingManager,
    metadata: VolumeMetadata,
  ): void {
    this.metadata = metadata;
    this.stats.setDatasetInfo(metadata, this.renderer.canvas.format, {
      includeCodec: true,
    });

    // Set up histogram computation when base LOD is loaded
    manager.setBaseLodLoadedCallback((brickData) => {
      this.onBaseLodLoaded(brickData);
    });

    this.stats.bindStreaming(manager);
  }

  /**
   * Record a frame time for performance tracking
   * Call this once per frame from the render loop
   */
  recordFrame(): void {
    this.stats.recordFrame();
    this.syncAutoLod();
  }

  private mountLodControls(parent: HTMLElement): void {
    const maxLod = this.viewer.metadata.maxLod;
    const formatLod = (v: number) => {
      if (v === 0) return "L0 (finest)";
      if (v === maxLod) return `L${v} (coarsest)`;
      return `L${v}`;
    };

    this.dataLodSlider = createSlider({
      label: "LOD",
      min: 0,
      max: maxLod,
      step: 1,
      value: this.params.dataLod,
      format: formatLod,
      onChange: (v) => {
        if (!this.params.dataLodManual) {
          this.params.dataLodManual = true;
          this.dataLodSlider.setChecked(false);
        }
        this.params.dataLod = v;
        this.viewer.forcedLod = v;
      },
      toggle: {
        checked: !this.params.dataLodManual,
        title: "Auto",
        onChange: (auto) => {
          this.params.dataLodManual = !auto;
          if (auto) {
            this.viewer.forcedLod = null;
            this.params.dataLod = this.viewer.finestStreamLod;
          } else {
            const seed = this.viewer.finestStreamLod;
            this.params.dataLod = seed;
            this.viewer.forcedLod = seed;
          }
          this.dataLodSlider.setValue(this.params.dataLod);
        },
      },
    });
    parent.appendChild(this.dataLodSlider.el);
  }

  private syncAutoLod(): void {
    if (this.params.dataLodManual) return;
    const lod = this.viewer.finestStreamLod;
    if (lod === this.params.dataLod) return;
    this.params.dataLod = lod;
    this.dataLodSlider.setValue(lod);
  }

  private setupTFCanvasEvents(): void {
    const canvas = this.tfCanvas;
    let lastClickTime = 0;

    const getPointAt = (x: number, y: number): number => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (x - rect.left) * scaleX;
      const canvasY = (y - rect.top) * scaleY;

      const points = this.transferFunction.getOpacityPoints();
      for (let i = 0; i < points.length; i++) {
        const px = points[i]!.x * canvas.width;
        const py = canvas.height - points[i]!.y * canvas.height;
        const dist = Math.sqrt((canvasX - px) ** 2 + (canvasY - py) ** 2);
        if (dist < 10) return i;
      }
      return -1;
    };

    canvas.addEventListener("mousedown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      const now = Date.now();
      const isDoubleClick = now - lastClickTime < 300;
      lastClickTime = now;

      const pointIndex = getPointAt(e.clientX, e.clientY);

      if (
        isDoubleClick &&
        pointIndex > 0 &&
        pointIndex < this.transferFunction.getOpacityPoints().length - 1
      ) {
        // Double click on non-endpoint: remove point
        const points = this.transferFunction.getOpacityPoints();
        points.splice(pointIndex, 1);
        this.transferFunction.setOpacityPoints(points);
        this.updateTFPreview();
      } else if (pointIndex >= 0) {
        // Start dragging existing point
        this.isDraggingPoint = true;
        this.dragPointIndex = pointIndex;
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", stopDrag);
      } else {
        // Add new point
        const x = canvasX / canvas.width;
        const y = 1 - canvasY / canvas.height;
        const points = this.transferFunction.getOpacityPoints();
        points.push({
          x: Math.max(0, Math.min(1, x)),
          y: Math.max(0, Math.min(1, y)),
        });
        this.transferFunction.setOpacityPoints(points);
        this.updateTFPreview();
      }
    });

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isDraggingPoint) return;

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      const points = this.transferFunction.getOpacityPoints();
      const point = points[this.dragPointIndex];
      if (!point) return;

      // Endpoints can only move vertically
      if (
        this.dragPointIndex === 0 ||
        this.dragPointIndex === points.length - 1
      ) {
        point.y = Math.max(0, Math.min(1, 1 - canvasY / canvas.height));
      } else {
        point.x = Math.max(0.01, Math.min(0.99, canvasX / canvas.width));
        point.y = Math.max(0, Math.min(1, 1 - canvasY / canvas.height));
      }

      this.transferFunction.setOpacityPoints(points);
      this.updateTFPreview();
    };

    const stopDrag = () => {
      if (!this.isDraggingPoint) return;
      this.isDraggingPoint = false;
      this.dragPointIndex = -1;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", stopDrag);
    };
  }

  private updateTFPreview(): void {
    this.transferFunction.renderPreview(
      this.tfCanvas,
      this.renderer.windowCenter,
      this.renderer.windowWidth,
    );
    this.renderer.resetAccumulation();
  }

  refreshTFPreview(): void {
    this.updateTFPreview();
  }

  /** Called when base LOD is loaded - computes and displays histogram */
  private onBaseLodLoaded(brickData: (Uint8Array | Uint16Array)[]): void {
    if (!this.metadata) return;

    const histogram = computeHistogram(
      brickData,
      this.metadata.bitDepth,
      256,
      this.metadata.isFloat ?? false,
      this.metadata.dataRange?.[0] ?? 0,
      this.metadata.dataRange?.[1] ?? 1,
      this.renderer.canvas.format,
    );
    this.transferFunction.setHistogram(histogram);
    this.updateTFPreview();
  }

  /** Sync UI params from current renderer/camera state (e.g. after applying URL params) */
  syncFromState(): void {
    this.params.renderMode = this.normalizeMode(this.renderer.volumeRenderMode);
    this.params.isoValue = this.renderer.isoValue;
    this.params.windowCenter = this.renderer.windowCenter;
    this.params.windowWidth = this.renderer.windowWidth;
    this.params.densityScale = this.renderer.densityScale;
    this.params.renderScale = this.viewer.renderScale;
    this.params.dataLodManual = this.viewer.forcedLod !== null;
    this.params.dataLod = this.viewer.forcedLod ?? this.viewer.finestStreamLod;
    this.params.upAxis = this.camera.getUpAxis();
    this.params.tfPreset = this.transferFunction.preset;
    const syncDims = this.viewer.metadata.dimensions;
    this.params.clipX = {
      min: Math.round(this.renderer.clipMin[0]! * syncDims[0]),
      max: Math.round(this.renderer.clipMax[0]! * syncDims[0]),
    };
    this.params.clipY = {
      min: Math.round(this.renderer.clipMin[1]! * syncDims[1]),
      max: Math.round(this.renderer.clipMax[1]! * syncDims[1]),
    };
    this.params.clipZ = {
      min: Math.round(this.renderer.clipMin[2]! * syncDims[2]),
      max: Math.round(this.renderer.clipMax[2]! * syncDims[2]),
    };
    this.params.sliceX = Math.round(this.renderer.sliceX * syncDims[0]);
    this.params.sliceY = Math.round(this.renderer.sliceY * syncDims[1]);
    this.params.sliceZ = Math.round(this.renderer.sliceZ * syncDims[2]);
    this.params.showSliceX = this.renderer.showSliceX;
    this.params.showSliceY = this.renderer.showSliceY;
    this.params.showSliceZ = this.renderer.showSliceZ;
    this.params.showWireframe = this.renderer.showWireframe;
    this.params.showAxis = this.renderer.showAxis;

    this.modeControl.setValue(this.params.renderMode);
    this.isoValueSlider.setValue(this.params.isoValue);
    this.windowCenterSlider.setValue(this.params.windowCenter);
    this.windowWidthSlider.setValue(this.params.windowWidth);
    this.densitySlider.setValue(this.params.densityScale);
    this.renderScaleSlider.setValue(this.params.renderScale);
    this.dataLodSlider.setChecked(!this.params.dataLodManual);
    this.dataLodSlider.setValue(this.params.dataLod);
    this.upAxisSelect.setValue(this.params.upAxis);
    this.tfPresetSelect.setValue(this.params.tfPreset);
    this.clipSliders[0].setValue(this.params.clipX.min, this.params.clipX.max);
    this.clipSliders[1].setValue(this.params.clipY.min, this.params.clipY.max);
    this.clipSliders[2].setValue(this.params.clipZ.min, this.params.clipZ.max);
    this.sliceRows[0].setValue(this.params.sliceX);
    this.sliceRows[0].setChecked(this.params.showSliceX);
    this.sliceRows[1].setValue(this.params.sliceY);
    this.sliceRows[1].setChecked(this.params.showSliceY);
    this.sliceRows[2].setValue(this.params.sliceZ);
    this.sliceRows[2].setChecked(this.params.showSliceZ);
    this.wireframeToggle.setValue(this.params.showWireframe);
    this.axesToggle.setValue(this.params.showAxis);

    this.updateVisibility();
    this.updateTFPreview();
  }

  private updateVisibility(): void {
    const mode = this.params.renderMode;
    const isSlice = mode === "slice";

    // Clipping planes only relevant in volume modes
    this.clipSection.style.display = isSlice ? "none" : "";

    // Mode-options region: TF (preset+canvas) shown for dvr/mip/slice (hidden
    // for iso, matching the shader's per-mode TF sampling); Density is
    // DVR-only; ISO gets its threshold slider instead of TF.
    const children: HTMLElement[] = [];
    if (mode === "slice") {
      children.push(
        this.sliceRows[0].el,
        this.sliceRows[1].el,
        this.sliceRows[2].el,
      );
    } else {
      if (mode !== "iso") {
        children.push(this.tfPresetEl, this.tfCanvasContainer);
      }
      if (mode === "iso") {
        children.push(this.isoValueSlider.el);
      }
      children.push(this.windowCenterSlider.el, this.windowWidthSlider.el);
      if (mode === "dvr") {
        children.push(this.densitySlider.el);
      }
    }
    this.modeSwap.setContent(children);
  }
}
