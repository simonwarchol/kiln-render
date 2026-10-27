/**
 * Splats panel — generate Gaussian splats from the volume as displayed,
 * switch Volume / Split / Splats views, save and load .ply files.
 */

import type { DisplayMode, KilnViewer } from "kiln-render";
import {
  createPanel,
  createSegmentedControl,
  createSelect,
  createSlider,
} from "../../../shared/controls/widgets.js";

const QUALITY = {
  fit: { train: false, iterations: 0, views: 0, resolution: 512, evaluate: 0 },
  fast: {
    train: true,
    iterations: 1500,
    views: 64,
    resolution: 512,
    evaluate: 4,
  },
  high: {
    train: true,
    iterations: 5000,
    views: 128,
    resolution: 768,
    evaluate: 4,
  },
} as const;
type Quality = keyof typeof QUALITY;

function download(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class SplatPanel {
  private readonly viewer: KilnViewer;
  private quality: Quality = "fast";
  private targetCount = 1_000_000;
  private abort: AbortController | null = null;
  private readonly modeControl: ReturnType<typeof createSegmentedControl>;
  private readonly splitSlider: ReturnType<typeof createSlider>;
  private readonly generateBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly datasetName: string;

  constructor(viewer: KilnViewer, datasetName: string) {
    this.viewer = viewer;
    this.datasetName = datasetName.replace(/\.[a-z0-9.]+$/i, "") || "splats";
    const container = document.createElement("div");
    container.className = "splat-panel-container";
    document.body.appendChild(container);
    const { el, body } = createPanel("Gaussian splats", {
      defaultCollapsed: false,
    });
    container.appendChild(el);

    this.modeControl = createSegmentedControl({
      options: [
        { label: "Volume", value: "volume" },
        { label: "Split", value: "split" },
        { label: "Splats", value: "splats" },
      ],
      value: viewer.displayMode,
      onChange: (v) => this.setMode(v as DisplayMode),
    });
    body.appendChild(this.modeControl.el);

    this.splitSlider = createSlider({
      label: "Divider",
      min: 0,
      max: 1,
      step: 0.01,
      value: viewer.splitFraction,
      format: (v) => `${Math.round(v * 100)}%`,
      onChange: (v) => {
        viewer.splitFraction = v;
      },
    });
    body.appendChild(this.splitSlider.el);

    body.appendChild(
      createSelect({
        label: "Splats",
        options: [
          { label: "250k", value: "250000" },
          { label: "500k", value: "500000" },
          { label: "1M", value: "1000000" },
          { label: "2M", value: "2000000" },
          { label: "3M", value: "3000000" },
        ],
        value: String(this.targetCount),
        onChange: (v) => {
          this.targetCount = Number(v);
        },
      }).el,
    );
    body.appendChild(
      createSelect({
        label: "Quality",
        options: [
          { label: "Fit only (seconds)", value: "fit" },
          { label: "Fit + train (fast)", value: "fast" },
          { label: "Fit + train (high)", value: "high" },
        ],
        value: this.quality,
        onChange: (v) => {
          this.quality = v as Quality;
        },
      }).el,
    );

    this.generateBtn = document.createElement("button");
    this.generateBtn.type = "button";
    this.generateBtn.className = "ctl-btn";
    this.generateBtn.textContent = "Generate splats";
    this.generateBtn.title =
      "Fit Gaussians to the volume as currently displayed (channels, windows, density, clip box), then refine them against volume renders";
    this.generateBtn.addEventListener("click", () => {
      if (this.abort) this.abort.abort();
      else void this.generate();
    });
    body.appendChild(this.generateBtn);

    const progress = document.createElement("div");
    progress.className = "splat-progress";
    this.bar = document.createElement("div");
    this.bar.className = "splat-progress-bar";
    progress.appendChild(this.bar);
    body.appendChild(progress);

    this.status = document.createElement("div");
    this.status.className = "splat-status";
    this.status.textContent = "No splats yet";
    body.appendChild(this.status);

    const fileRow = document.createElement("div");
    fileRow.className = "splat-file-row";
    this.saveBtn = document.createElement("button");
    this.saveBtn.type = "button";
    this.saveBtn.className = "ctl-btn";
    this.saveBtn.textContent = "Save .ply";
    this.saveBtn.disabled = true;
    this.saveBtn.addEventListener("click", () => {
      const ply = viewer.exportSplatPly();
      if (ply) download(`${this.datasetName}.splat.ply`, ply);
    });
    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "ctl-btn";
    loadBtn.textContent = "Load .ply";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ply";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (f) void this.loadFile(f);
      input.value = "";
    });
    loadBtn.addEventListener("click", () => input.click());
    fileRow.append(this.saveBtn, loadBtn, input);
    body.appendChild(fileRow);

    // Drop a .ply anywhere on the page.
    window.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    window.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f?.name.toLowerCase().endsWith(".ply")) return;
      e.preventDefault();
      void this.loadFile(f);
    });

    this.refresh();
  }

  private setMode(mode: DisplayMode): void {
    this.viewer.displayMode = mode;
    this.modeControl.setValue(mode);
    this.refresh();
  }

  private refresh(): void {
    const has = this.viewer.splatCount > 0;
    this.saveBtn.disabled = !has || !!this.abort;
    this.splitSlider.el.style.display =
      this.viewer.displayMode === "split" ? "" : "none";
  }

  private async loadFile(f: File): Promise<void> {
    try {
      const cloud = this.viewer.loadSplatPly(
        new Uint8Array(await f.arrayBuffer()),
      );
      this.status.textContent = `${cloud.count.toLocaleString()} splats from ${f.name}`;
      if (this.viewer.displayMode === "volume") this.setMode("split");
    } catch (err) {
      this.status.textContent = `Could not read ${f.name}: ${err instanceof Error ? err.message : err}`;
    }
    this.refresh();
  }

  private async generate(): Promise<void> {
    const q = QUALITY[this.quality];
    this.abort = new AbortController();
    this.generateBtn.textContent = "Cancel";
    this.refresh();
    const t0 = performance.now();
    if (this.viewer.displayMode === "volume") this.setMode("split");
    try {
      const cloud = await this.viewer.generateSplats({
        targetCount: this.targetCount,
        train: q.train,
        iterations: q.iterations || undefined,
        views: q.views || undefined,
        resolution: q.resolution,
        evaluateViews: q.evaluate,
        signal: this.abort.signal,
        onProgress: (p) => {
          const stageBase = { fit: 0, capture: 0.25, train: 0.45, done: 1 }[
            p.stage
          ];
          const stageSpan = {
            fit: q.train ? 0.25 : 1,
            capture: 0.2,
            train: 0.55,
            done: 0,
          }[p.stage];
          this.bar.style.width = `${Math.round((stageBase + stageSpan * p.fraction) * 100)}%`;
          this.status.textContent = p.label;
        },
      });
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      this.status.textContent = `${cloud.count.toLocaleString()} splats · built in ${secs}s`;
      this.bar.style.width = "100%";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        this.status.textContent = "Cancelled";
      } else {
        console.error("[Kiln] splat generation failed", err);
        this.status.textContent = `Failed: ${err instanceof Error ? err.message : err}`;
      }
      this.bar.style.width = "0%";
    } finally {
      this.abort = null;
      this.generateBtn.textContent = "Generate splats";
      this.refresh();
    }
  }
}
