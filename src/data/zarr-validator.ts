/**
 * Zarr dataset validation for Kiln Render. Supports OME-NGFF v0.4/v0.5.
 * Shared by dialog pre-validation and provider-level safety-net.
 */

import { type Group, open, type Readable, root } from "zarrita";
import { FileSystemStore } from "./filesystem-store.js";
import { looksLikeImsUrl } from "./imaris/probe.js";
import { TolerantFetchStore } from "./tolerant-fetch-store.js";

type CoordinateTransformations = { type: string; scale?: number[] }[];

/** OME-NGFF multiscales metadata (from group attributes) */
export interface OmeMultiscales {
  /** string[] (v0.4), {name, type}[] (v0.5) or absent — use normalizeAxes() */
  axes?: unknown;
  datasets: {
    path: string;
    coordinateTransformations?: CoordinateTransformations;
  }[];
  /** v0.4 group-level fallback */
  coordinateTransformations?: CoordinateTransformations;
  name?: string;
  version?: string;
}

/**
 * The multiscales group of a store: the root, or bioformats2raw's "0"
 * sub-group. `prefix` is that group's path relative to the root ("" or "0/").
 * @internal — zarrita types; stripped from the emitted .d.ts (stripInternal)
 *   so `zarrita` doesn't leak into published types.
 */
export async function openMultiscales<S extends Readable>(
  rootGroup: Group<S>,
): Promise<{
  group: Group<S>;
  attrs: Record<string, unknown>;
  ms: OmeMultiscales;
  prefix: string;
} | null> {
  const attrs = rootGroup.attrs as Record<string, unknown>;
  const ms = extractMultiscales(attrs);
  if (ms) return { group: rootGroup, attrs, ms, prefix: "" };
  try {
    const group = await open(rootGroup.resolve("0"), { kind: "group" });
    const subAttrs = group.attrs as Record<string, unknown>;
    const subMs = extractMultiscales(subAttrs);
    if (subMs) return { group, attrs: subAttrs, ms: subMs, prefix: "0/" };
  } catch {
    // no sub-group
  }
  return null;
}

/** Root metadata keys that identify a Zarr store (v2 group/array or v3 node). */
const ZARR_ROOT_KEYS = ["/zarr.json", "/.zgroup", "/.zarray"] as const;

/** True if parsed JSON looks like Zarr root metadata for the given key. */
function isZarrRootMetadata(key: string, data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  if (key === "/zarr.json") {
    // Zarr v3 requires zarr_format: 3; node_type alone is not sufficient.
    return (
      obj.zarr_format === 3 &&
      (obj.node_type === "group" || obj.node_type === "array")
    );
  }
  if (key === "/.zgroup") {
    return obj.zarr_format === 2;
  }
  if (key === "/.zarray") {
    return obj.zarr_format === 2 && ("shape" in obj || "chunks" in obj);
  }
  return false;
}

type ProbeResult =
  | { status: "hit" }
  | { status: "absent" }
  | { status: "error"; error: unknown };

/**
 * Lightweight probe of one root metadata key.
 * Mirrors TolerantFetchStore's 403/404/HTML→absent semantics, without retry backoff
 * (format detection should fail fast).
 */
async function probeZarrRootKey(
  baseUrl: string,
  key: string,
): Promise<ProbeResult> {
  try {
    const response = await fetch(`${baseUrl}${key}`);
    // 403/404 are intentional "not found" (CloudFront OAI, missing keys)
    if (response.status === 404 || response.status === 403)
      return { status: "absent" };
    if (!response.ok) {
      return {
        status: "error",
        error: new Error(`HTTP ${response.status} probing ${key}`),
      };
    }
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("text/html")) return { status: "absent" };
    try {
      const json: unknown = JSON.parse(await response.text());
      return { status: isZarrRootMetadata(key, json) ? "hit" : "absent" };
    } catch (error) {
      if (error instanceof SyntaxError) return { status: "absent" };
      return { status: "error", error };
    }
  } catch (error) {
    return { status: "error", error };
  }
}

/**
 * Probe a remote URL for Zarr root metadata (v2 `.zgroup`/`.zarray` or v3 `zarr.json`).
 * Used to choose between Zarr and Kiln sharded providers without relying on the URL path.
 *
 * Returns `true` when valid root metadata is found, `false` when all candidates are
 * clearly absent (404/403). Throws if the store is unreachable so callers can surface
 * a network error instead of silently falling back to the sharded provider.
 */
export async function isRemoteZarr(url: string): Promise<boolean> {
  if (looksLikeImsUrl(url)) return false;

  const baseUrl = url.replace(/\/$/, "");
  const results = await Promise.all(
    ZARR_ROOT_KEYS.map((key) => probeZarrRootKey(baseUrl, key)),
  );

  if (results.some((r) => r.status === "hit")) return true;
  if (results.every((r) => r.status === "absent")) return false;

  const first = results.find(
    (r): r is Extract<ProbeResult, { status: "error" }> => r.status === "error",
  );
  throw first?.error ?? new Error("Failed to probe zarr metadata");
}

/** Normalised axis descriptor used internally */
export interface NormalizedAxis {
  name: string;
  type: string;
}

/** Normalise axes from OME-NGFF v0.4 (strings) / v0.5 (typed objects) to uniform shape. */
export function normalizeAxes(raw: unknown): NormalizedAxis[] {
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    return [
      { name: "z", type: "space" },
      { name: "y", type: "space" },
      { name: "x", type: "space" },
    ];
  }
  return raw.map((a) => {
    if (typeof a === "string") {
      // v0.4 string form — infer type from conventional axis name
      const type = a === "t" ? "time" : a === "c" ? "channel" : "space";
      return { name: a, type };
    }
    const obj = a as { name?: string; type?: string };
    const name = obj.name ?? "";
    const type =
      obj.type ?? (name === "t" ? "time" : name === "c" ? "channel" : "space");
    return { name, type };
  });
}

/**
 * Extract the first multiscales entry from zarr group attrs.
 * Handles both v0.5 layout (attrs.ome.multiscales) and v0.4 (attrs.multiscales).
 */
export function extractMultiscales(
  attrs: Record<string, unknown>,
): OmeMultiscales | null {
  const omeAttr = attrs["ome"] as
    | { multiscales?: OmeMultiscales[] }
    | undefined;
  return (
    omeAttr?.multiscales?.[0] ??
    (attrs["multiscales"] as OmeMultiscales[] | undefined)?.[0] ??
    null
  );
}

/**
 * Validate whether a dataset is supported.
 * Returns a list of human-readable reasons; empty array means fully supported.
 * `chunks` (the array's chunk shape) enables the chunk layout checks.
 */
export function validateZarrSupport(
  ms: OmeMultiscales,
  firstArrayShape: number[],
  dtype: string,
  chunks?: number[],
): string[] {
  const reasons: string[] = [];
  const axes = normalizeAxes(ms.axes);

  if (ms.version && ms.version !== "0.5") {
    console.warn(
      `[Kiln] OME-NGFF version "${ms.version}" detected — parsing best-effort`,
    );
  }

  if (axes.some((a) => a.type === "time")) {
    console.warn("[Kiln] Time series detected — loading timepoint 0 only");
  }

  const channelIdx = axes.findIndex((a) => a.type === "channel");
  if (channelIdx >= 0 && (firstArrayShape[channelIdx] ?? 1) > 6) {
    console.warn(
      `[Kiln] Multi-channel dataset has ${firstArrayShape[channelIdx]} channels — only first 6 will be rendered`,
    );
  }
  const packed =
    chunks && packedChannelsReason(channelIdx, firstArrayShape, chunks);
  if (packed) reasons.push(packed);

  if (!["uint8", "uint16", "float32", "float64"].includes(dtype)) {
    reasons.push(
      `Data type "${dtype}" is not supported (only uint8, uint16, or float32)`,
    );
  } else if (dtype === "float64") {
    console.warn(
      "[Kiln] float64 detected — will be read as float32 (precision loss possible)",
    );
  }

  return reasons;
}

/**
 * Bricks read one channel per chunk: an array whose chunks span several
 * channels (channel axis `channelIdx`) would show the wrong data.
 */
export function packedChannelsReason(
  channelIdx: number,
  shape: number[],
  chunks: number[],
): string | null {
  if (channelIdx < 0 || (shape[channelIdx] ?? 1) <= 1) return null;
  const n = chunks[channelIdx] ?? 1;
  return n > 1
    ? `Chunks hold ${n} channels each; only one channel per chunk is supported (re-chunk with a channel chunk size of 1)`
    : null;
}

/** Result of probing an OME-Zarr store for support + channel count. */
export interface ZarrProbeResult {
  /** Human-readable rejection reasons; empty means supported. */
  reasons: string[];
  /** Channel axis length (1 when absent). */
  numChannels: number;
}

/** Channel count from multiscales axes + array shape (defaults to 1). */
export function countChannels(ms: OmeMultiscales, shape: number[]): number {
  const axes = normalizeAxes(ms.axes);
  const channelIdx = axes.findIndex((a) => a.type === "channel");
  if (channelIdx < 0) return 1;
  return Math.max(1, shape[channelIdx] ?? 1);
}

async function probeZarrGroup<S extends Readable>(
  rootGroup: Group<S>,
): Promise<ZarrProbeResult> {
  const found = await openMultiscales(rootGroup);
  if (!found) {
    return {
      reasons: ["No OME-NGFF multiscales metadata found"],
      numChannels: 1,
    };
  }
  const { group, ms } = found;
  const firstPath = ms.datasets[0]?.path;
  if (!firstPath) {
    return { reasons: ["Dataset has no array entries"], numChannels: 1 };
  }

  const arr = await open(group.resolve(firstPath), { kind: "array" });
  return {
    reasons: validateZarrSupport(ms, arr.shape, String(arr.dtype), arr.chunks),
    numChannels: countChannels(ms, arr.shape),
  };
}

/** Probe a remote zarr URL (metadata only) — support reasons + channel count. */
export async function probeRemoteZarr(url: string): Promise<ZarrProbeResult> {
  const store = new TolerantFetchStore(url.replace(/\/$/, ""));
  const rootGroup = await open(root(store), { kind: "group" });
  return probeZarrGroup(rootGroup);
}

/** Pre-validate a remote zarr URL (metadata only, no volume data fetched). */
export async function preValidateRemoteZarr(url: string): Promise<string[]> {
  return (await probeRemoteZarr(url)).reasons;
}

/** Probe a local zarr directory — support reasons + channel count. */
export async function probeLocalZarr(
  handle: FileSystemDirectoryHandle,
): Promise<ZarrProbeResult> {
  const store = new FileSystemStore(handle);
  const rootGroup = await open(root(store), { kind: "group" });
  return probeZarrGroup(rootGroup);
}

/**
 * Pre-validate a local zarr directory handle.
 * Same logic as preValidateRemoteZarr but reads from the local filesystem.
 */
export async function preValidateLocalZarr(
  handle: FileSystemDirectoryHandle,
): Promise<string[]> {
  return (await probeLocalZarr(handle)).reasons;
}
