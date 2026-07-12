# Local OME-Zarr (File System Access API)

Local `.zarr` or `.ome.zarr` directories can be loaded directly from disk without a server, using the browser's File System Access API.

> **Browser requirement:** Only supported in Chrome and Edge. Not available in Firefox or Safari.

```typescript
import {
  KilnViewer,
  LocalZarrDataProvider,
  promptForZarrDirectory,
  preValidateLocalZarr,
  getStoredHandle,
  requestPermission,
} from 'kiln-render';

// Show native directory picker and store the handle for later
const handle = await promptForZarrDirectory();

// Optional: check format support before loading
const issues = await preValidateLocalZarr(handle);
if (issues.length > 0) {
  console.error('Unsupported dataset:', issues);
  return;
}

const viewer = await KilnViewer.create(canvas, new LocalZarrDataProvider(handle));
```

## Restoring a handle across page loads

Handles are persisted in IndexedDB automatically when `promptForZarrDirectory()` is called. On subsequent visits:

```typescript
const handle = await getStoredHandle();
if (handle && await requestPermission(handle)) {
  const viewer = await KilnViewer.create(canvas, new LocalZarrDataProvider(handle));
}
```

To clear the stored handle:

```typescript
import { clearHandle } from 'kiln-render';
await clearHandle();
```

## Limitations vs. HTTP streaming

- Runs on the main thread (the `FileSystemDirectoryHandle` cannot be transferred to a worker)
- No HTTP Range streaming — each chunk is read fully from disk
- Otherwise identical feature support: LOD streaming, 16-bit, clipping, etc.
