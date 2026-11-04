/**
 * What a viewer needs from an Imaris file before its voxels: resolution
 * levels, voxel type, spacing, and each channel's name, colour and ranges.
 * Read from the file's attributes (a few small reads per channel, scattered
 * through a large file), or from a saved chunk index that carries it, so a
 * viewer can open the volume without reading the file.
 */

import { UnsupportedDatasetError } from "../data-provider.js";
import {
  type Hdf5AttrValue,
  Hdf5Dataset,
  type Hdf5File,
  Hdf5Group,
} from "../hdf5/index.js";
import type { SourceLevel, Vec3 } from "./ims-layout.js";

/** One channel as described by the file (all channels, not just active ones). */
export interface ImsChannelInfo {
  index: number;
  name: string;
  /** Display colour, linear 0–1 */
  color: [number, number, number];
  /** Normalisation range used for this channel (raw units) */
  range: [number, number];
  /** Imaris display range (raw units) */
  displayRange: [number, number] | null;
}

export interface ImsVolumeInfo {
  /** Resolution levels with voxels at the time point, finest first */
  levels: SourceLevel[];
  /** Voxel type of the finest level's channel 0 */
  dtype: { class: string; size: number; littleEndian: boolean };
  /** Its filters, e.g. "deflate"; "none" when unfiltered */
  compression: string;
  /** Physical voxel size at the finest level, from the image extents */
  voxelSpacing?: Vec3;
  /** DataSetInfo/Image Name, when the file sets one */
  name?: string;
  /** Every channel in the file */
  channels: ImsChannelInfo[];
}

export function attrString(v: Hdf5AttrValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v.replace(/\0+$/, "").trim();
  if (Array.isArray(v)) return v.map(String).join("").trim();
  return String(v);
}

export function attrNumber(v: Hdf5AttrValue | undefined): number | undefined {
  const s = attrString(v);
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function attrNumbers(v: Hdf5AttrValue | undefined): number[] | undefined {
  const s = attrString(v);
  if (!s) return undefined;
  const parts = s
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  return parts.length > 0 && parts.every(Number.isFinite) ? parts : undefined;
}

const unnamed = (s: string | undefined) =>
  !s || s === "(name not specified)" ? undefined : s;

/** Read the description from the file's attributes at `timepoint`. */
export async function readImsVolumeInfo(
  file: Hdf5File,
  timepoint: number,
): Promise<ImsVolumeInfo> {
  const dataSet = await file.get("/DataSet");
  if (!(dataSet instanceof Hdf5Group)) {
    throw new UnsupportedDatasetError([
      "Not an Imaris 5.5 file (missing /DataSet group)",
    ]);
  }
  const levelNames = (await dataSet.keys())
    .map((k) => ({ k, m: /^Resolution ?Level (\d+)$/.exec(k) }))
    .filter((e) => e.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]));
  const tp = `TimePoint ${timepoint}`;

  // Source levels (ImageSize attrs of channel 0)
  const levels: SourceLevel[] = [];
  const ch0Attrs: Array<Record<string, Hdf5AttrValue>> = [];
  const levelAttrs = await Promise.all(
    levelNames.map(async ({ k }) => {
      const g = await file.get(`/DataSet/${k}/${tp}/Channel 0`);
      return g instanceof Hdf5Group ? g.attrs() : null;
    }),
  );
  for (let i = 0; i < levelNames.length; i++) {
    const a = levelAttrs[i];
    if (!a) break;
    const x = attrNumber(a.ImageSizeX);
    const y = attrNumber(a.ImageSizeY);
    const z = attrNumber(a.ImageSizeZ);
    if (!x || !y || !z) break;
    levels.push({ index: Number(levelNames[i]!.m![1]), dims: [x, y, z] });
    ch0Attrs.push(a);
  }
  if (levels.length === 0) {
    throw new UnsupportedDatasetError([
      `IMS file has no ResolutionLevel / ${tp} / Channel 0 data`,
    ]);
  }

  const tpGroup = await file.get(`/DataSet/${levelNames[0]!.k}/${tp}`);
  const channelCount =
    tpGroup instanceof Hdf5Group
      ? (await tpGroup.keys()).filter((k) => /^Channel \d+$/.test(k)).length
      : 1;

  // Header only: chunk indexes are read per level, on first use.
  const probe = await file.get(
    `/DataSet/ResolutionLevel ${levels[0]!.index}/${tp}/Channel 0/Data`,
  );
  if (!(probe instanceof Hdf5Dataset)) {
    throw new Error("IMS dataset missing for the finest level");
  }
  const dt = probe.dtype;

  // Channel descriptions
  const info = await file.get("/DataSetInfo");
  const infoGroup = info instanceof Hdf5Group ? info : null;
  const typeMax = dt.class === "float" ? 1 : 2 ** (dt.size * 8) - 1;
  const channels = await Promise.all(
    Array.from({ length: channelCount }, async (_, c) => {
      const levelAttrs: Record<string, Hdf5AttrValue> =
        c === 0
          ? ch0Attrs[0]!
          : await (async () => {
              const g = await file.get(
                `/DataSet/${levelNames[0]!.k}/${tp}/Channel ${c}`,
              );
              return g instanceof Hdf5Group ? g.attrs() : {};
            })();
      const infoCh = infoGroup ? await infoGroup.get(`Channel ${c}`) : null;
      const ia = infoCh instanceof Hdf5Group ? await infoCh.attrs() : {};
      const hMin = attrNumber(levelAttrs.HistogramMin);
      const hMax = attrNumber(levelAttrs.HistogramMax);
      let lo = hMin ?? 0;
      let hi = hMax ?? typeMax;
      if (dt.class !== "float") lo = Math.max(0, lo);
      if (!(hi > lo)) hi = lo + 1;
      const rgb = attrNumbers(ia.Color);
      const color: [number, number, number] =
        rgb && rgb.length >= 3
          ? [
              Math.min(1, Math.max(0, rgb[0]!)),
              Math.min(1, Math.max(0, rgb[1]!)),
              Math.min(1, Math.max(0, rgb[2]!)),
            ]
          : [1, 1, 1];
      const cr = attrNumbers(ia.ColorRange);
      return {
        index: c,
        name: unnamed(attrString(ia.Name)) ?? `Channel ${c}`,
        color,
        range: [lo, hi] as [number, number],
        displayRange:
          cr && cr.length >= 2 ? ([cr[0]!, cr[1]!] as [number, number]) : null,
      };
    }),
  );

  // Geometry
  let voxelSpacing: Vec3 | undefined;
  let name: string | undefined;
  const image = infoGroup ? await infoGroup.get("Image") : null;
  if (image instanceof Hdf5Group) {
    const a = await image.attrs();
    const [sx, sy, sz] = levels[0]!.dims;
    const ext = (i: number) => {
      const lo = attrNumber(a[`ExtMin${i}`]);
      const hi = attrNumber(a[`ExtMax${i}`]);
      return lo !== undefined && hi !== undefined
        ? Math.abs(hi - lo)
        : undefined;
    };
    const dx = ext(0);
    const dy = ext(1);
    const dz = ext(2);
    if (dx && dy && dz) voxelSpacing = [dx / sx, dy / sy, dz / sz];
    name = unnamed(attrString(a.Name));
  }

  return {
    levels,
    dtype: { class: dt.class, size: dt.size, littleEndian: dt.littleEndian },
    compression: probe.filters.map((f) => f.name).join("+") || "none",
    ...(voxelSpacing ? { voxelSpacing } : {}),
    ...(name ? { name } : {}),
    channels,
  };
}

/** Why kiln can't show the volume (empty when it can). */
export function imsVolumeProblems(info: ImsVolumeInfo): string[] {
  const reasons: string[] = [];
  if (info.levels[0]!.dims[2] < 2) {
    reasons.push("IMS volume is not 3D (ImageSizeZ must be greater than 1)");
  }
  const dt = info.dtype;
  if (
    !(
      (dt.class === "uint" && (dt.size === 1 || dt.size === 2)) ||
      (dt.class === "int" && dt.size === 2) ||
      (dt.class === "float" && dt.size === 4)
    ) ||
    !dt.littleEndian
  ) {
    reasons.push(
      `Data type ${dt.class}${dt.size * 8}${dt.littleEndian ? "" : " (big-endian)"} is not supported`,
    );
  }
  return reasons;
}

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/** A description saved as JSON, or null if it isn't a complete one. */
export function parseImsVolumeInfo(v: unknown): ImsVolumeInfo | null {
  const info = v as Partial<ImsVolumeInfo> | null | undefined;
  const ok =
    !!info &&
    Array.isArray(info.levels) &&
    info.levels.length > 0 &&
    info.levels.every((l) => Number.isInteger(l?.index) && isVec3(l?.dims)) &&
    typeof info.dtype?.class === "string" &&
    Number.isInteger(info.dtype.size) &&
    typeof info.compression === "string" &&
    (info.voxelSpacing === undefined || isVec3(info.voxelSpacing)) &&
    Array.isArray(info.channels) &&
    info.channels.length > 0 &&
    info.channels.every(
      (c, i) =>
        c?.index === i &&
        typeof c.name === "string" &&
        isVec3(c.color) &&
        Array.isArray(c.range) &&
        c.range.length === 2,
    );
  return ok ? (info as ImsVolumeInfo) : null;
}
