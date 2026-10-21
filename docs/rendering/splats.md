# Gaussian splats

Kiln can turn the volume you are looking at into **3D Gaussian splats**, show them next to the volume with the same camera, and save/load them as standard 3DGS `.ply` files.

Everything runs in the browser on the GPU that is already rendering the volume — no Python, CUDA or external trainer.

## What gets converted

The splats reproduce the volume **as currently displayed**: the active channels, their colours and visibility, display windows, the transfer function (single channel), the density scale and the clip box. Change those first, then generate.

## Pipeline

1. **Fit** (seconds). Every voxel at a fitting LOD is classified exactly like the DVR shader classifies it, giving an emission colour and an extinction coefficient. Mass, colour and spatial moments are accumulated into an octree of 2³/4³/8³ voxel nodes; a cut through the tree is chosen to hit the requested splat count (homogeneous regions become a few large Gaussians, detailed regions many small ones). Each node becomes one moment-matched anisotropic Gaussian whose opacity absorbs the same amount of light as its voxels. This alone is a good approximation.
2. **Capture**. Kiln renders training views of the same volume with its DVR renderer — whole-volume orbits, a closer orbit and close-up detail views aimed at random points inside the volume — into a GPU texture array (premultiplied RGBA, transparent background). Close-up views stream full-resolution bricks; the first run downloads them, later runs read them from the persistent chunk cache.
3. **Train**. The fitted Gaussians are refined photometrically against those views: a tile-based differentiable rasterizer (forward + backward in WGSL), `0.8·L1 + 0.2·D-SSIM` loss on RGBA, sparse Adam, and periodic densification (clone/split the highest-gradient splats) and pruning.

The splat renderer used for display is the same rasterizer used in training, so what you see is what was optimised. It applies [Mip-Splatting](https://niujinshuchong.github.io/mip-splatting/)'s 2D filter: the usual 0.3 px² screen-space dilation is treated as an anti-aliasing blur and each splat's opacity is scaled by √(det Σ / det(Σ + 0.3 I)), so sub-pixel splats fade instead of turning into bright speckle and the result holds up at resolutions other than the training one. Kiln marks such clouds in the PLY (`comment kiln mip_filter 1`); `.ply` files from other 3DGS tools are rendered without the compensation, as they were trained.

Quality is measured on held-out views (a randomly rotated copy of the training-view layout): `evaluateViews` reports the mean PSNR of the splats against the volume render, composited as displayed. On the 2.6 GB melanoma sample (6 channels, 1M splats, 512² views) the fit alone scores ≈ 26–28 dB and the *fast* preset ≈ 34 dB.

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

- Needs WebGPU; uses the `subgroups` feature when available (faster gradient reductions) but does not require it.
- On an Apple M4, for the 2.6 GB / 6-channel melanoma sample: the fit takes ~3 s once bricks are cached; one training step on ~1M splats at 512² takes ~55–90 ms of GPU time (including D-SSIM; view-dependent); the *fast* preset finishes in ~5.5 min when the full-resolution chunks are already in the persistent OPFS store (≈2 min capturing training views, ≈35 s held-out views, ≈2.5 min training); the first run also downloads ~1.2 GB of chunks and takes ~12 min. Capture is bound by brick assembly on the CPU workers (~17 full-resolution 6-channel bricks/s).
- View-independent colour only (SH degree 0) — volume renders have no view-dependent shading to learn.
