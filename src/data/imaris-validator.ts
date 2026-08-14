/**
 * Imaris (.ims) detection and pre-validation.
 */

import {
  isHdf5Magic,
  looksLikeImsUrl,
  probeImsHeader,
} from "./imaris/probe.js";

export { looksLikeImsUrl } from "./imaris/probe.js";

export interface ImsProbeResult {
  reasons: string[];
  numChannels: number;
}

/**
 * Probe a remote URL for an Imaris HDF5 file.
 * Throws on network errors so callers do not silently fall back to sharded.
 */
export async function isRemoteIms(url: string): Promise<boolean> {
  if (!looksLikeImsUrl(url)) return false;
  const result = await probeImsHeader(url);
  if (result.status === "error") {
    throw result.error ?? new Error("Failed to probe IMS");
  }
  return result.status === "ims";
}

/** Cheap pre-check — full dtype/SizeZ validation runs in the worker on load. */
export async function preValidateRemoteIms(url: string): Promise<string[]> {
  if (!(await isRemoteIms(url))) {
    return [
      "No Imaris HDF5 file found at this URL (expected .ims with HDF5 magic)",
    ];
  }
  return [];
}

export async function probeRemoteIms(url: string): Promise<ImsProbeResult> {
  const reasons = await preValidateRemoteIms(url);
  return { reasons, numChannels: 1 };
}

/** Cheap pre-check on a local File — full dtype/SizeZ validation runs in the worker. */
export async function preValidateLocalIms(file: File): Promise<string[]> {
  if (!file.name.toLowerCase().endsWith(".ims")) {
    return ["Expected an Imaris .ims file"];
  }
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!isHdf5Magic(bytes)) {
    return ["Not an Imaris HDF5 file (missing HDF5 magic)"];
  }
  return [];
}
