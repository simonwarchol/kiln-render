# Kiln

A WebGPU viewer for large microscopy volumes — **Imaris (`.ims`)** first, OME-Zarr too — that streams multi-gigabyte files over HTTP at interactive framerates, **turns the volume into 3D Gaussian splats** in the browser, and plays the splats back side by side with the volume.

- **Imaris over plain HTTPS/S3** — a built-in async HDF5 reader fetches only the chunks it needs (coalesced `Range` requests, a shared de-duplicating fetcher, persistent OPFS chunk store, one decode per chunk), so a 2.6 GB, 18-channel float32 `.ims` shows a first image within seconds (≈8 s from a cold start against S3 in our tests, dominated by HDF5 metadata round trips) and refines progressively; revisits come from the local cache. Pick any 6 channels to render; names, colours and display ranges come from the file.
- **Volume → splats** — fit anisotropic Gaussians directly to the voxels (seconds), then refine them against Kiln's own volume renders with [Brush](https://github.com/ArthurBrussee/brush) (WebAssembly, in the browser). No Python/CUDA.
- **Playback** — splats render with the same camera as the volume (*Volume / Split / Splats*), and save/load as standard 3DGS `.ply` (SuperSplat, PlayCanvas, Brush…).

```text
https://<host>/kiln-render/app/?dataset=https://lsp-public-data.s3.amazonaws.com/yapp-2023-3d-melanoma/LSP22408.ims
```

**Documentation:** [Guide](docs/guide/introduction.md) · [Imaris](docs/data/imaris.md) · [Gaussian splats](docs/rendering/splats.md) · [full index](docs/README.md).

Kiln started as [MPanknin/kiln-render](https://github.com/MPanknin/kiln-render), an out-of-core OME-Zarr volume renderer (bounded GPU brick atlas, virtual-texture indirection, SSE-based LOD).

## Install

```bash
npm install kiln-render
```

Ships as an ES module with bundled dependencies and TypeScript types (including `@webgpu/types`) — no peer packages to install.

## Usage

```html
<canvas></canvas>
<p id="status"></p>
```

```js
import { KilnViewer } from 'kiln-render';

const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');

try {
  const viewer = await KilnViewer.create(
    canvas,
    'https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr',
  );
  status.textContent = `rendering — mode: ${viewer.mode}`;
  window.viewer = viewer;
} catch (err) {
  status.textContent = `failed: ${err.message}`;
  console.error(err);
}
```

`KilnViewer.create()` initialises WebGPU, sets up streaming, and starts the render loop; it rejects with a descriptive error if WebGPU is unavailable (hence the `try/catch`). See the [Quick start](docs/guide/quick-start.md) for `ViewerOptions`, viewer properties, state serialisation, and cleanup.

## Splats from code

```js
const cloud = await viewer.generateSplats({
  targetCount: 1_000_000, // fitted splats (training may densify)
  iterations: 3000,       // 0 / train: false → fit only
  onProgress: (p) => console.log(p.stage, p.label),
});
viewer.displayMode = "split"; // "volume" | "splats" | "split"
const ply = viewer.exportSplatPly();
```

See [Gaussian splats](docs/rendering/splats.md) for how the fit and training work.

## Features

- **Imaris 5.5 `.ims`** — remote (CORS `GET` + `Range` only; no `HEAD` needed) or local; any channel count (6 rendered at once, picker in the demo); uint8/uint16/int16/float32; gzip/shuffle/LZ4
- **Gaussian splats** — direct volume fit, GPU photometric refinement, built-in WebGPU splat renderer, `.ply` import/export
- **Out-of-core streaming** — fixed VRAM footprint, SSE-based LOD selection, LRU brick cache
- **Multichannel rendering** — up to 6 channels with per-channel colour, windowing, and visibility controls ([details](docs/rendering/multichannel.md))
- **OME-Zarr & Kiln binary** — stream from S3, CDN, or load local files (OME-Zarr v0.4/v0.5, uint8/uint16/float32)
- **Compute shader raymarching** — brick-aware DVR (with density scale), MIP, isosurface, and slice plane rendering

## Developing from source

Clone the repo and install dev dependencies (this is for working on Kiln itself — consumers only need `npm install kiln-render`, above):

```bash
# Install dependencies
pnpm install

# Start development server (single- + multi-channel; UI chosen by channel count)
pnpm dev

# Build demo for production
pnpm run build

# Build the library (outputs to lib/)
pnpm run build:lib
```

The demo loads a sample dataset from S3. To load custom datasets, see [Loading data](docs/guide/loading-data.md).

## Browser Requirements

Kiln requires **WebGPU** support:
- Chrome/Edge 113+
- Safari 26+
- Firefox 141+

Make sure hardware acceleration is enabled in your browser settings.

## License

Apache 2.0

---


