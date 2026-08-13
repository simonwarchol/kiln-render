/**
 * Kiln — application entry point. URL parsing, data provider selection,
 * dataset dialog, and share button. Rendering lives in KilnViewer.
 *
 * Single- and multi-channel datasets share this app: after create(), the UI
 * is chosen from viewer.renderer.numChannels (VolumeUI vs MultichannelUI).
 */

import {
  KilnViewer,
  LocalZarrDataProvider,
  UnsupportedDatasetError,
  VolumeRenderMode,
  getStoredHandle,
  requestPermission,
} from 'kiln-render';
import type { ViewerOptions, DataProvider, TFPreset, UpAxis } from 'kiln-render';
import { VolumeUI } from './ui/volume-ui.js';
import { MultichannelUI } from './ui/multichannel-ui.js';
import type { ChannelState } from './ui/multichannel-ui.js';
import { mountDatasetDialog, showDialogError } from '../../shared/dataset-dialog.js';
import { mountToast } from '../../shared/toast.js';
import { setupShareButton } from '../../shared/share-button.js';
import { mountTopBar } from '../../shared/top-bar.js';
import { trackEvent, trackDataset, trackRenderMode } from '../../shared/analytics.js';
import { maybeRunBench } from '../../shared/bench.js';
import '../../shared/viewer-shell.css';
import '../../shared/controls/controls.css';

// Default volume source (can be overridden via ?dataset= URL parameter)
const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/chameleon-16bit';

// ?embed=1 — rendering only: no top bar, dataset dialog, controls/stats panel,
// or share button. Camera orbit/pan/zoom still works — that's wired directly
// onto the canvas by the Camera class, independent of any of this example's UI.
const IS_EMBED = new URLSearchParams(window.location.search).get('embed') === '1';

interface MultiSliceParams {
  x: number;
  y: number;
  z: number;
  showX: boolean;
  showY: boolean;
  showZ: boolean;
}

/** Parse URL parameters for per-dataset configuration (single- + multi-channel schemas). */
function parseURLParams(): {
  dataset: string;
  mode?: VolumeRenderMode;
  wc?: number;
  ww?: number;
  density?: number;
  iso?: number;
  tf?: string;
  up?: string;
  sse?: number;
  scale?: number;
  /** Forced stream LOD (omit for Auto) */
  lod?: number;
  cam?: [number, number, number] | [number, number, number, number, number, number];
  clipMin?: [number, number, number];
  clipMax?: [number, number, number];
  slices?: [number, number, number];
  sliceVis?: [boolean, boolean, boolean];
  tfPoints?: Array<{ x: number; y: number }>;
  wireframe?: boolean;
  axis?: boolean;
  /** Multichannel share schema */
  channels?: ChannelState[];
  multiSlice?: MultiSliceParams;
} {
  const params = new URLSearchParams(window.location.search);
  let cam: [number, number, number] | [number, number, number, number, number, number] | undefined;
  const camStr = params.get('cam');
  if (camStr) {
    const parts = camStr.split(',').map(Number);
    if ((parts.length === 3 || parts.length === 6) && parts.every(n => !isNaN(n))) {
      cam = parts as typeof cam;
    }
  }

  let clipMin: [number, number, number] | undefined;
  let clipMax: [number, number, number] | undefined;
  const clipMinStr = params.get('clipMin');
  const clipMaxStr = params.get('clipMax');
  if (clipMinStr) {
    const parts = clipMinStr.split(',').map(Number);
    if (parts.length === 3 && parts.every(n => !isNaN(n))) {
      clipMin = parts as [number, number, number];
    }
  }
  if (clipMaxStr) {
    const parts = clipMaxStr.split(',').map(Number);
    if (parts.length === 3 && parts.every(n => !isNaN(n))) {
      clipMax = parts as [number, number, number];
    }
  }

  let slices: [number, number, number] | undefined;
  const slicesStr = params.get('slices');
  if (slicesStr) {
    const parts = slicesStr.split(',').map(Number);
    if (parts.length === 3 && parts.every(n => !isNaN(n))) {
      slices = parts as [number, number, number];
    }
  }

  let sliceVis: [boolean, boolean, boolean] | undefined;
  const sliceVisStr = params.get('sliceVis');
  if (sliceVisStr !== null) {
    const mask = parseInt(sliceVisStr, 10);
    if (!isNaN(mask)) {
      sliceVis = [!!(mask & 1), !!(mask & 2), !!(mask & 4)];
    }
  }

  let tfPoints: Array<{ x: number; y: number }> | undefined;
  const tfPtsStr = params.get('tfpts');
  if (tfPtsStr) {
    const nums = tfPtsStr.split(',').map(Number);
    if (nums.length >= 2 && nums.length % 2 === 0 && nums.every(n => !isNaN(n))) {
      tfPoints = [];
      for (let i = 0; i < nums.length; i += 2) {
        tfPoints.push({ x: nums[i]!, y: nums[i + 1]! });
      }
    }
  }

  let channels: ChannelState[] | undefined;
  const channelsStr = params.get('channels');
  if (channelsStr) {
    const parsed = channelsStr.split(';').map(part => {
      const nums = part.split(',').map(Number);
      return {
        r: (nums[0] ?? NaN) | 0,
        g: (nums[1] ?? NaN) | 0,
        b: (nums[2] ?? NaN) | 0,
        a: nums[3] ?? NaN,
        visible: (nums[4] ?? 0) !== 0,
        min: nums[5] ?? 0,
        max: nums[6] ?? 1,
      };
    });
    if (parsed.every(ch => !isNaN(ch.r) && !isNaN(ch.g) && !isNaN(ch.b) && !isNaN(ch.a))) {
      channels = parsed;
    }
  }

  let multiSlice: MultiSliceParams | undefined;
  const sliceStr = params.get('slice');
  if (sliceStr) {
    const parts = sliceStr.split(',').map(Number);
    if (parts.length === 6 && parts.every(n => !isNaN(n))) {
      multiSlice = {
        x: parts[0]!,
        y: parts[1]!,
        z: parts[2]!,
        showX: parts[3]! !== 0,
        showY: parts[4]! !== 0,
        showZ: parts[5]! !== 0,
      };
    }
  }

  return {
    dataset: params.get('dataset') ?? DEFAULT_VOLUME_SOURCE,
    mode: (params.get('mode') as VolumeRenderMode) ?? undefined,
    wc: params.has('wc') ? Number(params.get('wc')) : undefined,
    ww: params.has('ww') ? Number(params.get('ww')) : undefined,
    density: params.has('density') ? Number(params.get('density')) : undefined,
    iso: params.has('iso') ? Number(params.get('iso')) : undefined,
    tf: params.get('tf') ?? undefined,
    up: params.get('up') ?? undefined,
    sse: params.has('sse') ? Number(params.get('sse')) : undefined,
    scale: params.has('scale') ? Number(params.get('scale')) : undefined,
    lod: params.has('lod') ? Number(params.get('lod')) : undefined,
    cam,
    clipMin,
    clipMax,
    slices,
    sliceVis,
    tfPoints,
    wireframe: params.get('wireframe') === '1' ? true : undefined,
    axis: params.get('axis') === '1' ? true : undefined,
    channels,
    multiSlice,
  };
}

// Capture page load start time for time-to-first-render metric
const PAGE_LOAD_START = performance.now();

async function main() {
  const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('Canvas not found');

  const urlParams = parseURLParams();
  const volumeSource = urlParams.dataset;

  // ── Local Zarr handling (File System API) ──────────────────────────────────

  let dataset: string | DataProvider;
  let isLocalZarr = false;

  const params = new URLSearchParams(window.location.search);
  const useLocal = params.get('local') === 'true';
  const storedHandle = await getStoredHandle();

  if (useLocal && storedHandle) {
    const hasPermission = await requestPermission(storedHandle);
    if (hasPermission) {
      dataset = new LocalZarrDataProvider(storedHandle);
      isLocalZarr = true;
    } else {
      dataset = volumeSource;
    }
  } else {
    dataset = volumeSource;
  }

  // ── Build viewer options from URL params ───────────────────────────────────

  const options: ViewerOptions = {
    mode: urlParams.mode,
    windowCenter: urlParams.wc,
    windowWidth: urlParams.ww,
    densityScale: urlParams.density,
    isoValue: urlParams.iso,
    tfPreset: urlParams.tf as TFPreset | undefined,
    tfPoints: urlParams.tfPoints,
    upAxis: urlParams.up as UpAxis | undefined,
    cam: urlParams.cam,
    renderScale: urlParams.scale,
    maxPixelError: urlParams.sse,
    forcedLod:
      urlParams.lod !== undefined && !Number.isNaN(urlParams.lod) ? urlParams.lod : undefined,
    clipMin: urlParams.clipMin,
    clipMax: urlParams.clipMax,
    sliceX: urlParams.slices?.[0],
    sliceY: urlParams.slices?.[1],
    sliceZ: urlParams.slices?.[2],
    showSliceX: urlParams.sliceVis?.[0],
    showSliceY: urlParams.sliceVis?.[1],
    showSliceZ: urlParams.sliceVis?.[2],
    showWireframe: urlParams.wireframe,
    showAxis: urlParams.axis,
    pageLoadStart: PAGE_LOAD_START,
  };

  // ── Create viewer ──────────────────────────────────────────────────────────

  // Show spinner during metadata fetch + any pre-scans (cause 1: main-thread
  // scanFloatRange/scanChannelRanges can block for seconds on large base LODs).
  // The UI stats interval takes over once the viewer exists.
  document.getElementById('spinner')?.classList.add('active');
  const viewer = await KilnViewer.create(canvas, dataset, options);
  document.getElementById('spinner')?.classList.remove('active');

  const isMultichannel = viewer.renderer.numChannels > 1;
  topBar?.setDatasetName(viewer.metadata.name);
  if (isMultichannel) topBar?.setBeta(true);

  // Multichannel share links often set mode after create (ISO unsupported).
  if (
    isMultichannel &&
    (urlParams.mode === 'dvr' || urlParams.mode === 'mip' || urlParams.mode === 'slice')
  ) {
    viewer.mode = urlParams.mode;
  }

  trackEvent('webgpu-ok', 'WebGPU initialized');
  trackDataset(viewer.metadata.name);
  trackRenderMode(viewer.getState().mode);

  // Fetch-pattern benchmark — no-op unless ?bench=1 (see examples/shared/bench.ts).
  void maybeRunBench(viewer);

  // ── UI (skipped in embed mode — rendering + camera interaction only) ───────

  if (!IS_EMBED) {
    const toast = mountToast();

    if (isMultichannel) {
      const ui = new MultichannelUI(viewer, urlParams.channels, urlParams.multiSlice);
      viewer.onBeforeFrame = () => ui.recordFrame();
      viewer.onChannelWindowsChanged = () => ui.refreshChannelWindows();

      setupShareButton({
        isLocalZarr,
        toast,
        buildShareUrl: () => {
          const state = viewer.getState();
          const p = new URLSearchParams();
          if (volumeSource !== DEFAULT_VOLUME_SOURCE) p.set('dataset', volumeSource);
          p.set('up', state.upAxis);
          p.set('mode', state.mode);
          p.set('scale', state.renderScale.toFixed(2));
          if (state.forcedLod !== null) p.set('lod', String(state.forcedLod));
          const [rx, ry, dist, tx, ty, tz] = state.cam;
          p.set(
            'cam',
            `${rx.toFixed(3)},${ry.toFixed(3)},${dist.toFixed(3)},${tx.toFixed(3)},${ty.toFixed(3)},${tz.toFixed(3)}`,
          );
          const channelState = ui.getChannelState();
          if (channelState.length > 0) {
            p.set(
              'channels',
              channelState
                .map(
                  ch =>
                    `${ch.r},${ch.g},${ch.b},${ch.a.toFixed(2)},${ch.visible ? 1 : 0},${ch.min.toFixed(2)},${ch.max.toFixed(2)}`,
                )
                .join(';'),
            );
          }
          const sliceState = ui.getSliceState();
          p.set(
            'slice',
            `${sliceState.x},${sliceState.y},${sliceState.z},${sliceState.showX ? 1 : 0},${sliceState.showY ? 1 : 0},${sliceState.showZ ? 1 : 0}`,
          );
          return `${window.location.origin}${window.location.pathname}?${p.toString()}`;
        },
      });
    } else {
      const ui = new VolumeUI(viewer);
      viewer.onBeforeFrame = () => ui.recordFrame();
      ui.syncFromState();

      setupShareButton({
        isLocalZarr,
        toast,
        buildShareUrl: () => {
          const state = viewer.getState();
          const p = new URLSearchParams();
          if (volumeSource !== DEFAULT_VOLUME_SOURCE) p.set('dataset', volumeSource);
          p.set('mode', state.mode);
          p.set('wc', state.windowCenter.toFixed(2));
          p.set('ww', state.windowWidth.toFixed(2));
          p.set('density', state.densityScale.toFixed(2));
          p.set('iso', state.isoValue.toFixed(2));
          p.set('tf', state.tfPreset);
          p.set('tfpts', state.tfPoints.map(pt => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(','));
          p.set('up', state.upAxis);
          p.set('scale', state.renderScale.toFixed(2));
          if (state.forcedLod !== null) p.set('lod', String(state.forcedLod));
          const [rx, ry, dist, tx, ty, tz] = state.cam;
          p.set(
            'cam',
            `${rx.toFixed(3)},${ry.toFixed(3)},${dist.toFixed(3)},${tx.toFixed(3)},${ty.toFixed(3)},${tz.toFixed(3)}`,
          );

          if (state.clipMin[0] !== 0 || state.clipMin[1] !== 0 || state.clipMin[2] !== 0) {
            p.set('clipMin', state.clipMin.map(v => v.toFixed(2)).join(','));
          }
          if (state.clipMax[0] !== 1 || state.clipMax[1] !== 1 || state.clipMax[2] !== 1) {
            p.set('clipMax', state.clipMax.map(v => v.toFixed(2)).join(','));
          }

          if (state.showWireframe) p.set('wireframe', '1');
          if (state.showAxis) p.set('axis', '1');

          if (state.mode === 'slice') {
            p.set(
              'slices',
              `${state.sliceX.toFixed(2)},${state.sliceY.toFixed(2)},${state.sliceZ.toFixed(2)}`,
            );
            const visMask =
              (state.showSliceX ? 1 : 0) | (state.showSliceY ? 2 : 0) | (state.showSliceZ ? 4 : 0);
            if (visMask !== 7) p.set('sliceVis', String(visMask));
          }

          return `${window.location.origin}${window.location.pathname}?${p.toString()}`;
        },
      });
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  window.addEventListener('beforeunload', () => {
    viewer.dispose();
  });
}

function showError(message: string) {
  const el = document.getElementById('error');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
  console.error(message);
}

// Wire up the top bar (provides #load-dataset-btn / #share-btn) and dialog —
// skipped entirely in embed mode. Beta badge is enabled after load if multi-channel.
const topBar = IS_EMBED ? null : mountTopBar();
if (!IS_EMBED) {
  mountDatasetDialog({
    remoteDescription: 'Enter URL to an OME-Zarr dataset or Kiln sharded binary',
    docsLink: `${import.meta.env.VITE_REPO_URL || 'https://github.com/MPanknin/kiln-render'}/blob/main/docs/data/ome-zarr.md`,
  });
}

main().catch((e) => {
  if (e instanceof UnsupportedDatasetError) {
    showDialogError(e.reasons, true);
  } else {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'WebGPU not supported' || msg === 'WebGPU device creation failed') {
      trackEvent('webgpu-failed', msg);
    }
    showError(msg);
  }
});
