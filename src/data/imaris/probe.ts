/** Cheap Imaris / HDF5 probe (no h5wasm). */

const IMS_EXT = /\.ims$/i;
const HEADER_BYTES = 1024;
const HDF5_MAGIC = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

function urlPath(url: string): string {
  try {
    return new URL(url, "http://local.invalid").pathname;
  } catch {
    return url;
  }
}

export function looksLikeImsUrl(url: string): boolean {
  return IMS_EXT.test(urlPath(url));
}

export function isHdf5Magic(bytes: Uint8Array): boolean {
  if (bytes.length < HDF5_MAGIC.length) return false;
  return HDF5_MAGIC.every((b, i) => bytes[i] === b);
}

export async function probeImsHeader(
  url: string,
): Promise<{ status: "ims" | "absent" | "error"; error?: unknown }> {
  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${HEADER_BYTES - 1}` },
    });
    if (response.status === 404 || response.status === 403) {
      return { status: "absent" };
    }
    if (!response.ok && response.status !== 206) {
      return {
        status: "error",
        error: new Error(`HTTP ${response.status} probing IMS`),
      };
    }
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("text/html")) return { status: "absent" };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: isHdf5Magic(bytes) ? "ims" : "absent" };
  } catch (error) {
    return { status: "error", error };
  }
}
