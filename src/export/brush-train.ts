/**
 * In-browser Brush training via brush-js (WebGPU).
 * Falls back to a Nerfstudio dataset zip for the Brush web demo.
 */

import { unzipSync } from "fflate";
import { downloadBytes } from "./gaussian-ply.js";
import type { SplatDatasetResult } from "./splat-capture.js";

export const SUPERSPLAT_EDITOR_URL = "https://playcanvas.com/supersplat/editor";
export const BRUSH_DEMO_URL = "https://arthurbrussee.github.io/brush/";

export interface BrushTrainOptions {
  /** Max train step batches (each batch = 5 steps). Default 60 (~300 steps). */
  maxBatches?: number;
  onProgress?: (fraction: number, label: string) => void;
}

export type BrushTrainOutcome =
  | {
      kind: "trained";
      ply: Uint8Array;
    }
  | {
      kind: "dataset-only";
      zip: Uint8Array;
      appearancePly: Uint8Array | null;
      reason: string;
    };

interface BrushTraining {
  trainSteps: (n: number) => Promise<unknown[]>;
  currentSplats: () => {
    exportPly?: () => Uint8Array | Promise<Uint8Array>;
    toPly?: () => Uint8Array | Promise<Uint8Array>;
  } | null;
  free: () => void;
}

interface BrushAppInstance {
  init: () => Promise<void>;
  initExisting?: (
    adapter: GPUAdapter,
    device: GPUDevice,
    queue: GPUQueue,
  ) => Promise<void>;
  startTrainingFromDirectory: (
    dir: FileSystemDirectoryHandle,
    configFn: (cfg: unknown) => Promise<unknown>,
  ) => Promise<BrushTraining>;
}

interface BrushJsModule {
  BrushApp: new () => BrushAppInstance;
}

async function tryLoadBrushJs(): Promise<BrushJsModule | null> {
  try {
    const specifier = "brush-js";
    const mod = (await import(
      /* @vite-ignore */ specifier
    )) as unknown as BrushJsModule;
    if (mod?.BrushApp) return mod;
  } catch {
    // expected when brush-js is not installed
  }
  return null;
}

async function writeZipToDirectory(
  dir: FileSystemDirectoryHandle,
  zip: Uint8Array,
): Promise<void> {
  const files = unzipSync(zip);
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split("/").filter(Boolean);
    let cursor = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = await cursor.getDirectoryHandle(parts[i]!, { create: true });
    }
    const fileName = parts[parts.length - 1]!;
    const fh = await cursor.getFileHandle(fileName, { create: true });
    const writable = await fh.createWritable();
    await writable.write(data);
    await writable.close();
  }
}

async function exportPlyFromTraining(
  training: BrushTraining,
): Promise<Uint8Array | null> {
  const splats = training.currentSplats();
  if (!splats) return null;
  if (typeof splats.exportPly === "function") {
    return await splats.exportPly();
  }
  if (typeof splats.toPly === "function") {
    return await splats.toPly();
  }
  return null;
}

/** Prefer OPFS so training does not require a folder picker. */
async function getTrainingDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof storage.getDirectory === "function") {
    try {
      const root = await storage.getDirectory();
      const name = "kiln-brush-train";
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {
        /* first run */
      }
      return await root.getDirectoryHandle(name, { create: true });
    } catch (err) {
      console.warn("[Kiln] OPFS training dir failed, trying picker", err);
    }
  }

  const w = window as Window & {
    showDirectoryPicker?: (opts?: {
      mode?: string;
    }) => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof w.showDirectoryPicker !== "function") return null;
  try {
    return await w.showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return null;
  }
}

/**
 * Train Gaussians with Brush on the captured dataset.
 * On failure return the zip for the Brush web demo — do not treat init.ply as the product.
 */
export async function trainWithBrushOrPackage(
  dataset: SplatDatasetResult,
  device: GPUDevice,
  opts: BrushTrainOptions = {},
): Promise<BrushTrainOutcome> {
  const onProgress = opts.onProgress ?? (() => {});
  const maxBatches = opts.maxBatches ?? 60;
  const brush = await tryLoadBrushJs();
  if (!brush) {
    return {
      kind: "dataset-only",
      zip: dataset.zip,
      appearancePly: dataset.appearancePly,
      reason:
        "brush-js is not installed. The zip is a Nerfstudio dataset (images + transforms + seed init.ply). Train it in the Brush web demo, then open the exported PLY.",
    };
  }

  onProgress(0.05, "Preparing Brush training folder");
  const dir = await getTrainingDirectory();
  if (!dir) {
    return {
      kind: "dataset-only",
      zip: dataset.zip,
      appearancePly: dataset.appearancePly,
      reason:
        "No writable folder (OPFS / directory picker). Download the zip and train in the Brush web demo.",
    };
  }

  try {
    onProgress(0.1, "Writing dataset for Brush");
    await writeZipToDirectory(dir, dataset.zip);

    const app = new brush.BrushApp();
    try {
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: "high-performance",
      });
      if (adapter && app.initExisting) {
        await app.initExisting(adapter, device, device.queue);
      } else {
        await app.init();
      }
    } catch (err) {
      console.warn("[Kiln] brush initExisting failed, trying init()", err);
      await app.init();
    }

    onProgress(0.2, "Starting Brush training");
    const training = await app.startTrainingFromDirectory(
      dir,
      async (cfg) => cfg,
    );

    for (let i = 0; i < maxBatches; i++) {
      const msgs = await training.trainSteps(5);
      onProgress(
        0.2 + (0.75 * (i + 1)) / maxBatches,
        `Brush training batch ${i + 1}/${maxBatches}`,
      );
      if (!msgs || msgs.length === 0) break;
    }

    const ply = await exportPlyFromTraining(training);
    training.free();
    if (!ply) {
      return {
        kind: "dataset-only",
        zip: dataset.zip,
        appearancePly: dataset.appearancePly,
        reason:
          "Brush finished but PLY export was missing. Dataset is in the training folder — export PLY from Brush.",
      };
    }
    onProgress(1, "Brush training complete");
    return { kind: "trained", ply };
  } catch (err) {
    console.warn("[Kiln] Brush training failed", err);
    return {
      kind: "dataset-only",
      zip: dataset.zip,
      appearancePly: dataset.appearancePly,
      reason: `Brush training failed: ${err instanceof Error ? err.message : String(err)}. Dataset zip is ready for the Brush web demo.`,
    };
  }
}

/**
 * Present the trained splat. If training did not run, download the capture zip
 * (seed init.ply stays inside the zip — it is not the preview).
 */
export async function handoffToSuperSplat(
  outcome: BrushTrainOutcome,
): Promise<void> {
  if (outcome.kind === "trained") {
    const { presentSplatPly } = await import("./splat-viewer.js");
    await presentSplatPly(outcome.ply, { title: "Trained Gaussians" });
    return;
  }

  downloadBytes("kiln-splat-dataset.zip", outcome.zip, "application/zip");
  window.open(BRUSH_DEMO_URL, "_blank", "noopener,noreferrer");
}

export function openBrushDemo(): void {
  window.open(BRUSH_DEMO_URL, "_blank", "noopener,noreferrer");
}
