/**
 * Zarr dataset validation for Kiln Render. Supports OME-NGFF v0.4/v0.5.
 * Shared by dialog pre-validation and provider-level safety-net.
 */

import { open, root } from 'zarrita';
import { TolerantFetchStore } from './tolerant-fetch-store.js';
import { FileSystemStore } from './filesystem-store.js';

interface MultiscalesEntry {
  axes?: unknown; // may be string[] (v0.4) or {name,type}[] (v0.5) or absent
  datasets: { path: string }[];
  version?: string;
}

/** Root metadata keys that identify a Zarr store (v2 group/array or v3 node). */
const ZARR_ROOT_KEYS = ['/zarr.json', '/.zgroup', '/.zarray'] as const;

/** True if parsed JSON looks like Zarr root metadata for the given key. */
function isZarrRootMetadata(key: string, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (key === '/zarr.json') {
    // Zarr v3 requires zarr_format: 3; node_type alone is not sufficient.
    return obj.zarr_format === 3
      && (obj.node_type === 'group' || obj.node_type === 'array');
  }
  if (key === '/.zgroup') {
    return obj.zarr_format === 2;
  }
  if (key === '/.zarray') {
    return obj.zarr_format === 2 && ('shape' in obj || 'chunks' in obj);
  }
  return false;
}

type ProbeResult =
  | { status: 'hit' }
  | { status: 'absent' }
  | { status: 'error'; error: unknown };

/**
 * Lightweight probe of one root metadata key.
 * Mirrors TolerantFetchStore's 403/404/HTML→absent semantics, without retry backoff
 * (format detection should fail fast).
 */
async function probeZarrRootKey(baseUrl: string, key: string): Promise<ProbeResult> {
  try {
    const response = await fetch(`${baseUrl}${key}`);
    // 403/404 are intentional "not found" (CloudFront OAI, missing keys)
    if (response.status === 404 || response.status === 403) return { status: 'absent' };
    if (!response.ok) {
      return { status: 'error', error: new Error(`HTTP ${response.status} probing ${key}`) };
    }
    const ct = response.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) return { status: 'absent' };
    try {
      const json: unknown = JSON.parse(await response.text());
      return { status: isZarrRootMetadata(key, json) ? 'hit' : 'absent' };
    } catch (error) {
      if (error instanceof SyntaxError) return { status: 'absent' };
      return { status: 'error', error };
    }
  } catch (error) {
    return { status: 'error', error };
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
  const baseUrl = url.replace(/\/$/, '');
  const results = await Promise.all(
    ZARR_ROOT_KEYS.map(key => probeZarrRootKey(baseUrl, key)),
  );

  if (results.some(r => r.status === 'hit')) return true;
  if (results.every(r => r.status === 'absent')) return false;

  const first = results.find((r): r is Extract<ProbeResult, { status: 'error' }> => r.status === 'error');
  throw first?.error ?? new Error('Failed to probe zarr metadata');
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
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ];
  }
  return raw.map(a => {
    if (typeof a === 'string') {
      // v0.4 string form — infer type from conventional axis name
      const type = a === 't' ? 'time' : a === 'c' ? 'channel' : 'space';
      return { name: a, type };
    }
    const obj = a as { name?: string; type?: string };
    const name = obj.name ?? '';
    const type = obj.type ?? (name === 't' ? 'time' : name === 'c' ? 'channel' : 'space');
    return { name, type };
  });
}

/**
 * Extract the first multiscales entry from zarr group attrs.
 * Handles both v0.5 layout (attrs.ome.multiscales) and v0.4 (attrs.multiscales).
 */
export function extractMultiscales(attrs: Record<string, unknown>): MultiscalesEntry | null {
  const omeAttr = attrs['ome'] as { multiscales?: MultiscalesEntry[] } | undefined;
  return (
    omeAttr?.multiscales?.[0] ??
    (attrs['multiscales'] as MultiscalesEntry[] | undefined)?.[0] ??
    null
  );
}

/**
 * Validate whether a dataset is supported.
 * Returns a list of human-readable reasons; empty array means fully supported.
 */
export function validateZarrSupport(
  ms: MultiscalesEntry,
  firstArrayShape: number[],
  dtype: string,
): string[] {
  const reasons: string[] = [];
  const axes = normalizeAxes(ms.axes);

  if (ms.version && ms.version !== '0.5') {
    console.warn(`[Kiln] OME-NGFF version "${ms.version}" detected — parsing best-effort`);
  }

  if (axes.some(a => a.type === 'time')) {
    console.warn('[Kiln] Time series detected — loading timepoint 0 only');
  }

  const channelIdx = axes.findIndex(a => a.type === 'channel');
  if (channelIdx >= 0 && (firstArrayShape[channelIdx] ?? 1) > 4) {
    console.warn(
      `[Kiln] Multi-channel dataset has ${firstArrayShape[channelIdx]} channels — only first 4 will be rendered`,
    );
  }

  if (!['uint8', 'uint16', 'float32', 'float64'].includes(dtype)) {
    reasons.push(`Data type "${dtype}" is not supported (only uint8, uint16, or float32)`);
  } else if (dtype === 'float64') {
    console.warn('[Kiln] float64 detected — will be read as float32 (precision loss possible)');
  }

  return reasons;
}

/** Result of probing an OME-Zarr store for support + channel count. */
export interface ZarrProbeResult {
  /** Human-readable rejection reasons; empty means supported. */
  reasons: string[];
  /** Channel axis length (1 when absent). */
  numChannels: number;
}

/** Channel count from multiscales axes + array shape (defaults to 1). */
export function countChannels(ms: MultiscalesEntry, shape: number[]): number {
  const axes = normalizeAxes(ms.axes);
  const channelIdx = axes.findIndex(a => a.type === 'channel');
  if (channelIdx < 0) return 1;
  return Math.max(1, shape[channelIdx] ?? 1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function probeZarrGroup(rootGroup: any): Promise<ZarrProbeResult> {
  const attrs = rootGroup.attrs as Record<string, unknown>;

  // Try root attrs first; fall back to bioformats2raw sub-group "0"
  let ms = extractMultiscales(attrs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let group: any = rootGroup;
  if (!ms) {
    try {
      const subGroup = await open(rootGroup.resolve('0'), { kind: 'group' });
      ms = extractMultiscales(subGroup.attrs as Record<string, unknown>);
      if (ms) group = subGroup;
    } catch {
      // sub-group doesn't exist
    }
  }

  if (!ms) {
    return { reasons: ['No OME-NGFF multiscales metadata found'], numChannels: 1 };
  }

  const firstPath = ms.datasets[0]?.path;
  if (!firstPath) {
    return { reasons: ['Dataset has no array entries'], numChannels: 1 };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arr = await open(group.resolve(firstPath), { kind: 'array' }) as any;
  const shape = arr.shape as number[];
  return {
    reasons: validateZarrSupport(ms, shape, String(arr.dtype)),
    numChannels: countChannels(ms, shape),
  };
}

/** Probe a remote zarr URL (metadata only) — support reasons + channel count. */
export async function probeRemoteZarr(url: string): Promise<ZarrProbeResult> {
  const store = new TolerantFetchStore(url.replace(/\/$/, ''));
  const rootGroup = await open(root(store), { kind: 'group' });
  return probeZarrGroup(rootGroup);
}

/** Pre-validate a remote zarr URL (metadata only, no volume data fetched). */
export async function preValidateRemoteZarr(url: string): Promise<string[]> {
  return (await probeRemoteZarr(url)).reasons;
}

/** Probe a local zarr directory — support reasons + channel count. */
export async function probeLocalZarr(handle: FileSystemDirectoryHandle): Promise<ZarrProbeResult> {
  const store = new FileSystemStore(handle);
  const rootGroup = await open(root(store), { kind: 'group' });
  return probeZarrGroup(rootGroup);
}

/**
 * Pre-validate a local zarr directory handle.
 * Same logic as preValidateRemoteZarr but reads from the local filesystem.
 */
export async function preValidateLocalZarr(handle: FileSystemDirectoryHandle): Promise<string[]> {
  return (await probeLocalZarr(handle)).reasons;
}
