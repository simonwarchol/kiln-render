import type { DataProvider } from "./data-provider.js";
import { ImarisDataProvider } from "./imaris-provider.js";
import { isRemoteIms, looksLikeImsUrl } from "./imaris-validator.js";

/**
 * A data provider for a dataset URL: Imaris `.ims`, OME-Zarr, or Kiln's
 * sharded format, for `KilnViewer.create`. Zarr and sharded support (and
 * zarrita) load only when a URL needs them, and apps that construct their
 * own provider don't bundle them at all.
 */
export async function openDataset(url: string): Promise<DataProvider> {
  if (looksLikeImsUrl(url) && (await isRemoteIms(url))) {
    return new ImarisDataProvider(url);
  }
  const [{ isRemoteZarr }, { ZarrDataProvider }, { ShardedDataProvider }] =
    await Promise.all([
      import("./zarr-validator.js"),
      import("./zarr-provider.js"),
      import("./sharded-provider.js"),
    ]);
  return (await isRemoteZarr(url))
    ? new ZarrDataProvider(url)
    : new ShardedDataProvider(url);
}
