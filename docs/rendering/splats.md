# Gaussian splats

Kiln can turn the volume you are looking at into **3D Gaussian splats**, show them next to the volume with the same camera, and save/load them as standard 3DGS `.ply` files.

Everything runs in the browser on the GPU that is already rendering the volume — no Python or CUDA. Training uses [Brush](https://github.com/ArthurBrussee/brush) (Apache-2.0), built to WebAssembly and vendored in `vendor/brush-js`.

## What gets converted

The splats reproduce the volume **as currently displayed**: the active channels, their colours and visibility, display windows, the transfer function (single channel), the density scale and the clip box. Change those first, then generate.

## Pipeline

1. **Fit** (seconds). Every voxel at a fitting LOD is classified exactly like the DVR shader classifies it, giving an emission colour and an extinction coefficient. Mass, colour and spatial moments are accumulated into an octree of 2³/4³/8³ voxel nodes; a cut through the tree is chosen to hit the requested splat count (homogeneous regions become a few large Gaussians, detailed regions many small ones). Each node becomes one moment-matched anisotropic Gaussian whose opacity absorbs the same amount of light as its voxels. This alone is a good approximation.
2. **Capture**. Kiln renders training views of the same volume with its DVR renderer — whole-volume orbits, a closer orbit and close-up detail views aimed at random points inside the volume — into a GPU texture array (premultiplied RGBA, transparent background). Close-up views stream full-resolution bricks; the first run downloads them, later runs read them from the persistent chunk cache.
3. **Train**. Brush refines the fitted Gaussians against those views, on a `GPUDevice` of its own. Kiln writes the views to the Origin Private File System as a Nerfstudio dataset (PNGs, `transforms.json` with each view's camera, and the fitted cloud as `init.ply`), starts Brush on that folder with SH degree 0, Mip-Splatting and transparent-background training, and reads the result straight out of Brush's GPU buffers. The folder is deleted afterwards.

Brush keeps training images as 8-bit straight-alpha RGBA, so a target pixel can be no brighter than its alpha, while Kiln's additive multichannel DVR often is where channels overlap. Colour enters the render linearly, so Kiln divides the targets (and the starting cloud) by the smallest gain that brings every pixel in range and multiplies the trained colours back.

Every render mode (Volume, MIP, Surface) is trained the same way, with ordinary front-to-back blending. That matches Volume and Surface renders; a maximum-intensity projection has no consistent front-to-back equivalent, so MIP splats come out softer and dimmer than the MIP they were trained on.

Kiln displays splats with its own tile rasterizer. It applies [Mip-Splatting](https://niujinshuchong.github.io/mip-splatting/)'s 2D filter: the usual 0.3 px² screen-space dilation is treated as an anti-aliasing blur and each splat's opacity is scaled by √(det Σ / det(Σ + 0.3 I)), so sub-pixel splats fade instead of turning into bright speckle and the result holds up at resolutions other than the training one. Kiln marks such clouds in the PLY (`comment kiln mip_filter 1`); `.ply` files from other 3DGS tools are rendered without the compensation, as they were trained.

Quality is measured on held-out views (a randomly rotated copy of the training-view layout): `evaluateViews` reports the mean PSNR of the splats against the volume render, composited as displayed. On the 2.6 GB melanoma sample (6 channels, 1M splats, 512² views) the fit alone scores ≈ 26–28 dB and the *fast* preset ≈ 34 dB.

When the views that will be shown are known — a story's waypoints — pass them as orbit states (what `camera.getOrbitState()` returns): `extraViews` are captured and trained on alongside the generated views, and `evaluateAt` scores the result at those cameras instead of generated held-out views. Tiled builds ignore both, since a tile's cloud covers only part of what those cameras frame.

## In the demo

The **Gaussian splats** panel (top right):

- **Volume / Split / Splats** — what the canvas shows. *Split* shows the volume left of the divider and splats right of it (set with the **Divider** slider).
- **Splats** — target count (250k–3M).
- **Quality** — *Fit only* (seconds), *Fit + train (fast)* (~1500 steps, 64 views at 512²), *Fit + train (high)* (5000 steps, 128 views at 768²).
- **Save .ply / Load .ply** — also accepts a `.ply` dropped onto the page.

## API

```ts
const viewer = await KilnViewer.create(canvas, url);

// Fit + train with live progress
const cloud = await viewer.generateSplats({
  targetCount: 1_000_000,
  iterations: 3000,
  views: 96,
  resolution: 640,
  onProgress: (p) => console.log(p.stage, p.label),
});

viewer.displayMode = 'split';     // 'volume' | 'splats' | 'split'
viewer.splitFraction = 0.5;

const ply = viewer.exportSplatPly(); // Uint8Array, INRIA 3DGS layout
viewer.loadSplatPly(await file.arrayBuffer());
```

## PLY format

Binary little-endian, INRIA layout (`x y z`, `f_dc_0..2`, `opacity` logit, `scale_0..2` log, `rot_0..3` wxyz), SH degree 0 — readable by SuperSplat, PlayCanvas, Brush and most 3DGS viewers. Positions are in Kiln's normalised volume space (centred, longest physical axis = 1); a `comment kiln world_scale <µm>` header line records the physical size of one unit. Colours may exceed 1 where channels overlap (Kiln's additive multichannel compositing), which the SH DC term represents directly.

## Limits

- Needs WebGPU with `subgroups`. Brush's shader compiler (CubeCL) uses subgroup builtins without the `enable subgroups;` directive browsers require, so Kiln adds it to Brush's shaders.
- The vendored Brush is commit `79e8d37` (2026-05-31); newer commits don't train in a browser yet (see `vendor/brush-js/README.md`). Rebuild with `pnpm build:brush-js [commit]`.
- The vendored `brush_js_bg.wasm` is ≈40 MB (not run through `wasm-opt`); it is loaded only when training starts.
- On an Apple M4, for the 2.6 GB / 6-channel melanoma sample: the fit takes ~3 s once bricks are cached; one training step on ~1M splats at 512² takes ~55–90 ms of GPU time (including D-SSIM; view-dependent); the *fast* preset finishes in ~5.5 min when the full-resolution chunks are already in the persistent OPFS store (≈2 min capturing training views, ≈35 s held-out views, ≈2.5 min training); the first run also downloads ~1.2 GB of chunks and takes ~12 min. Capture is bound by brick assembly on the CPU workers (~17 full-resolution 6-channel bricks/s).
- View-independent colour only (SH degree 0) — volume renders have no view-dependent shading to learn.
