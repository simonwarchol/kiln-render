/**
 * Multi-channel viewer UI controls — dependency-free (Phase 3 of the
 * interface redesign; Tweakpane removed from user-facing UI entirely).
 */

import type { Camera, UpAxis } from "@kiln/core/camera.js";
import type { Renderer } from "@kiln/core/renderer.js";
import type { VolumeMetadata } from "@kiln/data/data-provider.js";
import type { StreamingManager } from "@kiln/streaming/streaming-manager.js";
import type { KilnViewer, VolumeRenderMode } from "kiln-render";
import { trackRenderMode } from "../../../shared/analytics.js";
import {
  createCollapsible,
  createColorSwatch,
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

/** Only 'dvr' | 'mip' | 'slice' are selectable via the Mode segmented control. */
type BaseRenderMode = "dvr" | "mip" | "slice";

// Default channel colors matching renderer defaults
const CHANNEL_COLOR_DEFAULTS = [
  { r: 0, g: 0, b: 255 }, // ch0: blue
  { r: 255, g: 255, b: 0 }, // ch1: yellow
  { r: 255, g: 0, b: 0 }, // ch2: red
  { r: 255, g: 255, b: 255 }, // ch3: white
  { r: 0, g: 255, b: 255 }, // ch4: cyan
  { r: 255, g: 0, b: 255 }, // ch5: magenta
];

export interface ChannelState {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
  a: number; // 0-1
  visible: boolean;
  min: number; // 0-1 normalized
  max: number; // 0-1 normalized
}

interface ChannelWidgets {
  toggle: ReturnType<typeof createToggle>;
  swatch: ReturnType<typeof createColorSwatch>;
  level: ReturnType<typeof createRangeSlider>;
  row: HTMLElement;
}

export class MultichannelUI {
  private viewer: KilnViewer;
  private renderer: Renderer;
  private camera: Camera;
  private stats: StatsPanel;

  private params = {
    upAxis: "-y" as UpAxis,
    renderMode: "dvr" as BaseRenderMode,
    renderScale: 0.5,
    /** Manual Data LOD override (toggle off = Auto SSE) */
    dataLodManual: false,
    dataLod: 0,
    showWireframe: false,
    showAxis: false,
    sliceX: 0,
    sliceY: 0,
    sliceZ: 0,
    showSliceX: true,
    showSliceY: true,
    showSliceZ: true,
  };

  // Per-channel params — populated dynamically in constructor
  private channelParams: Array<{
    color: { r: number; g: number; b: number; a: number };
    visible: boolean;
    level: { min: number; max: number };
  }> = [];
  private channelWidgets: ChannelWidgets[] = [];

  private initialSlice?: {
    x: number;
    y: number;
    z: number;
    showX: boolean;
    showY: boolean;
    showZ: boolean;
  };
  /** When true, auto-leveling from base LOD will not overwrite URL-restored channel windows. */
  private channelsRestoredFromURL = false;

  private modeControl!: ReturnType<typeof createSegmentedControl>;
  private modeSwap!: ReturnType<typeof createSwapRegion>;
  private sliceRows!: [
    ReturnType<typeof createSliderToggleRow>,
    ReturnType<typeof createSliderToggleRow>,
    ReturnType<typeof createSliderToggleRow>,
  ];
  private channelRackEl!: HTMLElement;
  private upAxisSelect!: ReturnType<typeof createSelect>;
  private wireframeToggle!: ReturnType<typeof createToggle>;
  private axesToggle!: ReturnType<typeof createToggle>;
  private renderScaleSlider!: ReturnType<typeof createSlider>;
  private dataLodSlider!: ReturnType<typeof createSlider>;

  constructor(
    viewer: KilnViewer,
    initialChannels?: ChannelState[],
    initialSlice?: {
      x: number;
      y: number;
      z: number;
      showX: boolean;
      showY: boolean;
      showZ: boolean;
    },
  ) {
    this.viewer = viewer;
    this.renderer = viewer.renderer;
    this.camera = viewer.camera;

    // Sync initial values
    this.initialSlice = initialSlice;
    this.params.upAxis = this.camera.getUpAxis();
    this.params.renderMode = this.normalizeMode(this.viewer.mode);
    if (this.viewer.mode !== this.params.renderMode) {
      this.viewer.mode = this.params.renderMode;
    }
    this.params.showWireframe = this.renderer.showWireframe;
    this.params.showAxis = this.renderer.showAxis;
    this.params.renderScale = this.renderer.renderScale;
    const initialForced = this.viewer.forcedLod;
    this.params.dataLodManual = initialForced !== null;
    this.params.dataLod = initialForced ?? this.viewer.finestStreamLod;

    // Build per-channel params from renderer state (or URL-restored state)
    if (initialChannels && initialChannels.length > 0) {
      this.channelsRestoredFromURL = true;
    }
    for (let i = 0; i < this.renderer.numChannels; i++) {
      const restored = initialChannels?.[i];
      if (restored) {
        this.channelParams.push({
          color: { r: restored.r, g: restored.g, b: restored.b, a: restored.a },
          visible: restored.visible,
          level: { min: restored.min, max: restored.max },
        });
        this.renderer.setChannelColor(
          i,
          restored.r / 255,
          restored.g / 255,
          restored.b / 255,
          restored.visible ? restored.a : 0,
        );
        this.renderer.setChannelWindow(
          i,
          (restored.min + restored.max) / 2,
          Math.max(0.001, restored.max - restored.min),
        );
        this.viewer.streamingManager.setChannelEnabled(i, restored.visible);
      } else {
        const defaults = CHANNEL_COLOR_DEFAULTS[i] ?? {
          r: 255,
          g: 255,
          b: 255,
        };
        const base = i * 4;
        let min = 0,
          max = 1;
        const w = viewer.metadata.channelWindows?.[i];
        if (w && w.max > w.min) {
          const range = w.max - w.min;
          min = Math.max(0, Math.min(1, (w.start - w.min) / range));
          max = Math.max(0, Math.min(1, (w.end - w.min) / range));
        }
        this.channelParams.push({
          color: {
            r: Math.round(
              (this.renderer.channelColors[base] ?? defaults.r / 255) * 255,
            ),
            g: Math.round(
              (this.renderer.channelColors[base + 1] ?? defaults.g / 255) * 255,
            ),
            b: Math.round(
              (this.renderer.channelColors[base + 2] ?? defaults.b / 255) * 255,
            ),
            a: this.renderer.channelColors[base + 3] ?? 1.0,
          },
          visible: true,
          level: { min, max },
        });
        this.renderer.setChannelWindow(
          i,
          (min + max) / 2,
          Math.max(0.001, max - min),
        );
      }
    }

    // Controls pane — top-left, below top bar
    const controlsContainer = document.createElement("div");
    controlsContainer.style.cssText =
      "position: fixed; left: 8px; top: 44px; z-index: 1000;";
    document.body.appendChild(controlsContainer);

    // Stats pane — bottom-left
    const statsContainer = document.createElement("div");
    statsContainer.style.cssText =
      "position: fixed; right: 8px; bottom: calc(36px + env(safe-area-inset-bottom, 0px)); z-index: 1000;";
    document.body.appendChild(statsContainer);
    this.stats = new StatsPanel(statsContainer);

    this.buildPanel(controlsContainer);
    this.initStreaming(viewer.streamingManager, viewer.metadata);
  }

  private normalizeMode(mode: VolumeRenderMode): BaseRenderMode {
    if (mode === "dvr" || mode === "mip" || mode === "slice") return mode;
    if (mode === "slice-lod") return "slice";
    return "dvr";
  }

  private applyMode(): void {
    this.viewer.mode = this.params.renderMode;
    this.updateVisibility();
  }

  private buildPanel(container: HTMLElement): void {
    const { el: panelEl, body } = createPanel("Controls", {
      defaultCollapsed: false,
    });
    container.appendChild(panelEl);

    this.modeControl = createSegmentedControl({
      options: [
        { label: "DVR", value: "dvr" },
        { label: "MIP", value: "mip" },
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

    this.modeSwap = createSwapRegion();
    body.appendChild(this.modeSwap.el);
    this.buildChannelRack();
    this.buildSliceRows();

    // --- Scene section (collapsible, open by default) ---
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

    this.updateVisibility();
  }

  private buildChannelRack(): void {
    this.channelRackEl = document.createElement("div");
    for (let ch = 0; ch < this.renderer.numChannels; ch++) {
      const chParam = this.channelParams[ch]!;

      const row = document.createElement("div");
      row.className = "ctl-channel-row";

      const wrapper = document.createElement("div");
      wrapper.className = "ctl-channel-group";
      wrapper.classList.toggle("off", !chParam.visible);

      const toggle = createToggle({
        label: "",
        value: chParam.visible,
        onChange: (v) => {
          chParam.visible = v;
          wrapper.classList.toggle("off", !v);
          const c = chParam.color;
          this.renderer.setChannelColor(
            ch,
            c.r / 255,
            c.g / 255,
            c.b / 255,
            v ? c.a : 0,
          );
          this.viewer.streamingManager.setChannelEnabled(ch, v);
        },
      });

      const swatch = createColorSwatch({
        value: chParam.color,
        onChange: (rgb) => {
          chParam.color.r = rgb.r;
          chParam.color.g = rgb.g;
          chParam.color.b = rgb.b;
          const alpha = chParam.visible ? chParam.color.a : 0;
          this.renderer.setChannelColor(
            ch,
            rgb.r / 255,
            rgb.g / 255,
            rgb.b / 255,
            alpha,
          );
        },
      });

      const name = document.createElement("span");
      name.className = "ctl-channel-name";
      name.textContent = `Channel ${ch}`;

      // Identity (swatch + name) reads left-to-right; the visibility toggle
      // right-aligns with every other control in the panel grid.
      row.appendChild(swatch.el);
      row.appendChild(name);
      row.appendChild(toggle.el);

      // No per-channel "Level" label — the strip layout makes it obvious, and
      // repeating the word four times was pure noise.
      const level = createRangeSlider({
        label: "",
        min: 0,
        max: 1,
        step: 0.01,
        valueMin: chParam.level.min,
        valueMax: chParam.level.max,
        onChange: (min, max) => {
          chParam.level.min = min;
          chParam.level.max = max;
          this.renderer.setChannelWindow(
            ch,
            (min + max) / 2,
            Math.max(0.001, max - min),
          );
        },
      });
      level.el.classList.add("ctl-channel-level");

      wrapper.appendChild(row);
      wrapper.appendChild(level.el);

      this.channelWidgets.push({ toggle, swatch, level, row: wrapper });
      this.channelRackEl.appendChild(wrapper);
    }
  }

  private buildSliceRows(): void {
    const sliceDims = this.viewer.metadata.dimensions;
    if (this.initialSlice) {
      this.params.sliceX = this.initialSlice.x;
      this.params.sliceY = this.initialSlice.y;
      this.params.sliceZ = this.initialSlice.z;
      this.params.showSliceX = this.initialSlice.showX;
      this.params.showSliceY = this.initialSlice.showY;
      this.params.showSliceZ = this.initialSlice.showZ;
      this.renderer.sliceX = this.initialSlice.x / sliceDims[0];
      this.renderer.sliceY = this.initialSlice.y / sliceDims[1];
      this.renderer.sliceZ = this.initialSlice.z / sliceDims[2];
      this.renderer.showSliceX = this.initialSlice.showX;
      this.renderer.showSliceY = this.initialSlice.showY;
      this.renderer.showSliceZ = this.initialSlice.showZ;
    } else {
      this.params.sliceX = Math.round(sliceDims[0] / 2);
      this.params.sliceY = Math.round(sliceDims[1] / 2);
      this.params.sliceZ = Math.round(sliceDims[2] / 2);
    }

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
  }

  private initStreaming(
    manager: StreamingManager,
    metadata: VolumeMetadata,
  ): void {
    this.stats.setDatasetInfo(metadata, this.renderer.canvas.format, {
      fileSizeChannelMultiplier: metadata.numChannels,
    });
    this.stats.bindStreaming(manager);
  }

  /**
   * Re-read per-channel window/level from metadata and update the UI sliders.
   * Called when ranges are derived after base LOD loading.
   */
  refreshChannelWindows(): void {
    // Don't clobber URL-restored channel windows with auto-leveled values
    if (this.channelsRestoredFromURL) return;

    const windows = this.viewer.metadata.channelWindows;
    if (!windows) return;

    for (let i = 0; i < this.channelParams.length; i++) {
      const w = windows[i];
      if (!w || w.max <= w.min) continue;
      const range = w.max - w.min;
      const min = Math.max(0, Math.min(1, (w.start - w.min) / range));
      const max = Math.max(0, Math.min(1, (w.end - w.min) / range));
      this.channelParams[i]!.level.min = min;
      this.channelParams[i]!.level.max = max;
      this.renderer.setChannelWindow(
        i,
        (min + max) / 2,
        Math.max(0.001, max - min),
      );
      this.channelWidgets[i]?.level.setValue(min, max);
    }
  }

  getChannelState(): ChannelState[] {
    return this.channelParams.map((ch) => ({
      r: ch.color.r,
      g: ch.color.g,
      b: ch.color.b,
      a: ch.color.a,
      visible: ch.visible,
      min: ch.level.min,
      max: ch.level.max,
    }));
  }

  getSliceState(): {
    x: number;
    y: number;
    z: number;
    showX: boolean;
    showY: boolean;
    showZ: boolean;
  } {
    return {
      x: this.params.sliceX,
      y: this.params.sliceY,
      z: this.params.sliceZ,
      showX: this.params.showSliceX,
      showY: this.params.showSliceY,
      showZ: this.params.showSliceZ,
    };
  }

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

  private updateVisibility(): void {
    const isSlice = this.params.renderMode === "slice";
    const children: HTMLElement[] = isSlice
      ? [this.sliceRows[0].el, this.sliceRows[1].el, this.sliceRows[2].el]
      : [this.channelRackEl];
    this.modeSwap.setContent(children);
  }
}
