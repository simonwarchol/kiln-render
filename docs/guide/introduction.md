# Introduction

Kiln is a WebGPU-native, out-of-core volume renderer for large volumetric datasets. It streams multi-gigabyte volumes over HTTP into a bounded GPU residency/atlas cache, resolving them through virtual-texture indirection.

Kiln streams [OME-Zarr](/data/ome-zarr) (NGFF v0.4/v0.5) and [Imaris](/data/imaris) (`.ims`) datasets directly — single-channel and multichannel, up to 6 channels — as well as a compressed [sharded binary format](/data/sharded-binary). Input can be `uint8`, `uint16`, or `float32`; `uint16` and `float32` are converted to `r16float` for GPU storage.

## Where to next

- **[Quick start](/guide/quick-start)** — get a viewer rendering a streamed volume in a few lines.
- **[Loading data](/guide/loading-data)** — remote OME-Zarr, Imaris, local files, and multichannel datasets.
- **[URL parameters](/guide/url-parameters)** — share and bookmark specific views.
- **[Gallery](/gallery)** — live example datasets, each opening directly in the viewer.
- **[Architecture](/architecture/overview)** — how the virtual texturing and streaming systems work.
