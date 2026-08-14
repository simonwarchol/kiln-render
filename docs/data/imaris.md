# Imaris (.ims)

Kiln can stream compatible **Imaris 5.5** HDF5 volumes (`.ims`) directly over HTTP — including objects on public S3 — with no conversion step. The browser issues HTTP Range requests against a single file.

Unlike OME-TIFF (XY-only overviews), Imaris stores a **true 3D pyramid**: each `ResolutionLevel` is a chunked XYZ volume and **Z is downsampled** when that axis is long enough. Coarse levels are therefore a handful of bricks, the same idea as OME-Zarr.

## Requirements

- **Imaris 5.5 HDF5** (not the older Classic / Imaris3 formats)
- **3D** — `ImageSizeZ > 1`
- **Timepoint 0** only
- **Channels** — up to 6 (extras are ignored); see [Multichannel](/rendering/multichannel)
- **Dtypes:** `uint8`, `uint16`, `float32`
- **Transport:** HTTPS with **CORS** and **HTTP Range** (`206 Partial Content`). The host must advertise `Content-Length` (S3 does).

HDF5 I/O runs in Web Workers (the WASM reader needs synchronous Range fetches).

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
