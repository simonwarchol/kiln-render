# Imaris (.ims)

Kiln can stream compatible **Imaris 5.5** HDF5 volumes (`.ims`) directly over HTTP — including objects on public S3 — with no conversion step. The browser issues HTTP Range requests against a single file.

Unlike OME-TIFF (XY-only overviews), Imaris stores a **true 3D pyramid**: each `ResolutionLevel` is a chunked XYZ volume and **Z is downsampled** when that axis is long enough. Coarse levels are therefore a handful of bricks, the same idea as OME-Zarr.

## Requirements

- **Imaris 5.5 HDF5** (not the older Classic / Imaris3 formats)
- **3D** — `ImageSizeZ > 1`
- **One time point at a time** — `new ImarisDataProvider(url, { timepoint })` (default 0)
- **Channels** — any number in the file; up to 6 are streamed and rendered at once. Pick them with `new ImarisDataProvider(url, { channels: [0, 3, 5] })`, `?ch=0,3,5` in the demo, or the **Choose…** button above the channel list. Names and colours come from `DataSetInfo/Channel N`; default display windows from `ColorRange`; see [Multichannel](/rendering/multichannel)
- **Dtypes:** `uint8`, `uint16`, `int16`, `float32` (little-endian)
- **Compression:** gzip/deflate, shuffle, fletcher32, LZ4 (HDF5 plugin 32004)
- **Transport:** HTTPS with **CORS** for `GET` and the **`Range`** header (`206 Partial Content`). `HEAD` is never used and neither `Content-Length` nor `Content-Range` needs to be exposed, so buckets that only allow CORS `GET` work.

### How it streams

Kiln reads `.ims` files with its own small, fully asynchronous HDF5 reader (`src/data/hdf5/`):

1. **Metadata** — the file head (where Imaris writes groups and attributes) is fetched in one request, then object headers, dense link/attribute heaps and chunk B-trees are read through a page cache. The chunk index of a channel/level is read the first time it is needed.
2. **Chunk bytes** — a single fetcher on the main thread de-duplicates requests (neighbouring bricks share chunks through their ghost borders), coalesces nearby byte ranges into one `Range` read, keeps a compressed LRU in memory and a persistent copy in the **Origin Private File System** (one file per chunk, read through a small queue because OPFS slows down sharply under concurrent reads), so a reload — or splat generation re-reading full resolution — does not touch the network again.
3. **Bricks** — each chunk has one *owner* Web Worker (by address hash) that inflates it once (native `DecompressionStream`), keeps it normalised as float16 in an LRU, and hands out only the sub-region a brick needs. Kiln bricks carry a 1-voxel ghost border, so most bricks touch neighbouring chunks for a sliver only; owning chunks avoids decoding the same 1 MB chunk once per neighbouring brick. Another worker then box-resamples the pieces into the 66³ brick.

Imaris pyramids are anisotropic (Z is only halved once it is long enough), while Kiln's renderer expects every LOD to be exactly 2× coarser on every axis. The provider therefore exposes a **virtual isotropic pyramid** and builds each brick from the coarsest Imaris level that is still at least as fine on every axis. Values are normalised per channel to `[0, 1]` using the level-0 `HistogramMin/Max`, so `uint8`, `uint16` and `float32` files all land in the same `r16float` atlas space.

## Usage

```typescript
import { KilnViewer } from 'kiln-render';

const viewer = await KilnViewer.create(
  canvas,
  'https://my-bucket.s3.amazonaws.com/scan.ims',
);
```

`.ims` URLs are probed as Imaris (HDF5 magic) and skip the Zarr metadata fetch. Other URLs are probed as Zarr, then [sharded binary](/data/sharded-binary). You can also construct the provider yourself:

```typescript
import { KilnViewer, ImarisDataProvider, preValidateRemoteIms } from 'kiln-render';

const url = 'https://example.com/volume.ims';
const issues = await preValidateRemoteIms(url);
if (issues.length > 0) throw new Error(issues.join('; '));

const viewer = await KilnViewer.create(canvas, new ImarisDataProvider(url));
```

Local files (Chrome/Edge File System Access API):

```typescript
import {
  KilnViewer,
  ImarisDataProvider,
  promptForImsFile,
  preValidateLocalIms,
} from 'kiln-render';

const handle = await promptForImsFile();
const file = await handle.getFile();
const issues = await preValidateLocalIms(file);
if (issues.length > 0) throw new Error(issues.join('; '));

const viewer = await KilnViewer.create(canvas, new ImarisDataProvider(file));
```

In the demo viewer: **Load Dataset → Remote URL**, **Local Imaris File**, or `?dataset=` with the `.ims` HTTPS URL.

## Hosting on S3

Same CORS + Range rules as other Kiln formats. See [Hosting for streaming](/data/hosting). The object must be publicly readable (or a pre-signed URL that still allows `Range`).

## Out of scope

- Imaris Classic / Imaris3 (non-HDF5)
- Authenticated private buckets
- Time series (timepoint 0 only)

## Related

- [OME-Zarr](/data/ome-zarr) — preferred when you already have NGFF
- [Hosting](/data/hosting) — CORS and Range
- [Network & formats](/architecture/network-formats) — how bricks are fetched
