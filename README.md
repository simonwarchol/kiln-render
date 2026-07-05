# Kiln

A WebGPU-native out-of-core volume rendering system for large virtualized volumetric datasets.

Kiln streams multi-gigabyte volumes over HTTP, rendering them at interactive framerates using a fixed-size VRAM page cache and virtual texture indirection. Supports single-channel and multichannel OME-Zarr datasets (up to 4 channels).

> **v0.4.0-beta** — Multichannel rendering is new in this release. See [Multichannel](docs/multichannel.md) for details and known limitations.

**Documentation:** [Usage Guide](docs/usage-guide.md) · [Multichannel](docs/multichannel.md) · [Architecture](docs/architecture.md) · [Rendering Pipeline](docs/rendering.md) · [Data Guide](docs/data-guide.md) · [WebGPU Notes](docs/webgpu.md) · [Examples](docs/examples.md) · [References](docs/references.md)

---

<a href="https://mpanknin.github.io/kiln-render/?mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C3.930%2C0.108%2C0.001%2C-0.066" target="_blank">
<img width="1725" height="907" alt="Chameleon CT Scan — 2160 MB, 1024 × 1024 × 1080 @ 16-bit" src="https://github.com/user-attachments/assets/f5da8ea1-a924-4ba6-9f29-6f6c18369405" />
</a>

*Chameleon CT scan — 2160 MB, 1024 × 1024 × 1080 @ 16-bit · [Live Demo](https://mpanknin.github.io/kiln-render/?mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C3.930%2C0.108%2C0.001%2C-0.066) · [More examples](docs/examples.md)*

## Features

- **Out-of-core streaming** — Fixed VRAM footprint, SSE-based LOD selection, LRU brick cache
- **Multichannel rendering** — Up to 4 channels with per-channel colour, windowing, and visibility controls ([details](docs/multichannel.md))
- **OME-Zarr & Kiln binary** — Stream from S3, CDN, or load local files (OME-Zarr v0.4/v0.5, uint8/uint16/float32)
- **Local filesystem** — Load local `.zarr` / `.ome.zarr` directories via the File System Access API (Chrome/Edge)
- **16-bit & float32 support** — Native 16-bit textures with window/level controls; float32 stored internally as r16float
- **Compute shader raymarching** — Brick-aware DVR (with density scale), MIP, isosurface, and slice plane rendering

## Development

```bash
# Install dependencies
npm install

# Start development server (single-channel demo)
npm run dev

# Start multichannel demo
npm run dev:multichannel

# Build demo for production
npm run build

# Build the library (outputs to lib/)
npm run build:lib
```

The demo loads a sample dataset from S3. To load custom datasets, see the [Usage Guide](docs/usage-guide.md).

## Browser Requirements

Kiln requires **WebGPU** support:
- Chrome/Edge 113+
- Safari 26+
- Firefox 141+

Make sure hardware acceleration is enabled in your browser settings.

## License

Apache 2.0

---


