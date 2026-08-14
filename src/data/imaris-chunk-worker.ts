/**
 * Imaris brick worker — h5wasm + sync Range I/O (must run in a Worker).
 */

import h5wasm, { type Dataset, FS, type Group } from "h5wasm";
import { MAX_CHANNELS } from "../core/config.js";
import {
  float32ToFloat16Bits,
  getUint16ToFloat16Lut,
} from "../utils/float16.js";
import { describeImsDtype, parseImsDtype } from "./imaris/dtype.js";
import {
  createRangeLazyFile,
  type RangeLazyArray,
} from "./imaris/lazy-file.js";

export interface ImsLevelInfo {
  lod: number;
  dimensions: [number, number, number];
  brickGrid: [number, number, number];
  brickCount: number;
}

export interface ImsWorkerMetadata {
  name: string;
  dimensions: [number, number, number];
  voxelSpacing?: [number, number, number];
  levels: ImsLevelInfo[];
  bitDepth: 8 | 16;
  isFloat: boolean;
  numChannels: number;
  compression?: string;
  reasons: string[];
}

export type ImsWorkerRequest =
  | { type: "init"; id: number; url: string }
  | { type: "init"; id: number; file: File }
  | {
      type: "loadBrick";
      id: number;
      lod: number;
      bx: number;
      by: number;
      bz: number;
      channelIndex: number;
      dispatchTime: number;
    }
  | {
      type: "setTargetFormat";
      id: number;
      targetFormat: "r8unorm" | "r16unorm" | "r16float";
    }
  | { type: "setFloatRange"; id: number; floatMin: number; floatMax: number }
  | { type: "cancel"; id: number };

export interface ImsWorkerResponse {
  type: string;
  id: number;
  error?: string;
  metadata?: ImsWorkerMetadata;
  data?: ArrayBuffer;
  min?: number;
  max?: number;
  avg?: number;
  rawMin?: number;
  rawMax?: number;
  fetchMs?: number;
  assemblyMs?: number;
  queueMs?: number;
  chunkStoreBytes?: number;
  chunkStoreRequests?: number;
}

const LOGICAL = 64;
const PHYSICAL = 66;
const FILE_NAME = "volume.ims";

let file: InstanceType<typeof h5wasm.File> | null = null;
let lazy: RangeLazyArray | null = null;
let levels: ImsLevelInfo[] = [];
let is16bit = false;
let isFloat = false;
let targetFormat: "r8unorm" | "r16unorm" | "r16float" = "r16float";
let floatMin = 0;
let floatMax = 1;
const cancelled = new Set<number>();

function attrStr(entity: Group | Dataset, name: string): string | undefined {
  const attr = entity.attrs[name];
  if (!attr) return undefined;
  const v = attr.value;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (Array.isArray(v)) return v.map(String).join("");
  return v != null ? String(v) : undefined;
}

function attrNum(entity: Group | Dataset, name: string): number | undefined {
  const s = attrStr(entity, name);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function resolutionGroupName(root: Group, index: number): string | null {
  const keys = root.keys();
  const spaced = `ResolutionLevel ${index}`;
  const extra = `Resolution Level ${index}`;
  if (keys.includes(spaced)) return spaced;
  if (keys.includes(extra)) return extra;
  return null;
}

function openDataset(channelGroup: Group): Dataset {
  const data = channelGroup.get("Data");
  if (!data || !("slice" in data)) {
    throw new Error("IMS channel is missing a Data dataset");
  }
  return data as Dataset;
}

function readMetadata(h5: InstanceType<typeof h5wasm.File>): ImsWorkerMetadata {
  const reasons: string[] = [];
  const dataSet = h5.get("DataSet");
  if (!dataSet || !("keys" in dataSet)) {
    return {
      name: "ims",
      dimensions: [1, 1, 1],
      levels: [],
      bitDepth: 8,
      isFloat: false,
      numChannels: 1,
      reasons: ["Not an Imaris 5.5 file (missing /DataSet group)"],
    };
  }
  const ds = dataSet as Group;

  const levelInfos: ImsLevelInfo[] = [];
  for (let i = 0; i < 32; i++) {
    const key = resolutionGroupName(ds, i);
    if (!key) break;
    const level = ds.get(key) as Group | null;
    const ch0 = level?.get("TimePoint 0")
      ? ((level.get("TimePoint 0") as Group).get("Channel 0") as Group | null)
      : null;
    if (!ch0) break;
    const sizeX = attrNum(ch0, "ImageSizeX");
    const sizeY = attrNum(ch0, "ImageSizeY");
    const sizeZ = attrNum(ch0, "ImageSizeZ");
    if (!sizeX || !sizeY || !sizeZ) break;
    const brickGrid: [number, number, number] = [
      Math.ceil(sizeX / LOGICAL),
      Math.ceil(sizeY / LOGICAL),
      Math.ceil(sizeZ / LOGICAL),
    ];
    levelInfos.push({
      lod: i,
      dimensions: [sizeX, sizeY, sizeZ],
      brickGrid,
      brickCount: brickGrid[0] * brickGrid[1] * brickGrid[2],
    });
  }

  if (levelInfos.length === 0) {
    reasons.push("IMS file has no ResolutionLevel / Channel 0 data");
  }

  const tp0 = ds.get(
    resolutionGroupName(ds, 0) ?? "ResolutionLevel 0",
  ) as Group | null;
  const time0 = tp0?.get("TimePoint 0") as Group | null;
  const channelKeys =
    time0?.keys().filter((k) => k.startsWith("Channel ")) ?? [];
  const numChannels = Math.min(Math.max(1, channelKeys.length), MAX_CHANNELS);
  if (channelKeys.length > MAX_CHANNELS) {
    console.warn(
      `[Kiln] IMS dataset has ${channelKeys.length} channels — only first ${MAX_CHANNELS} will be rendered`,
    );
  }

  const ch0 = time0?.get("Channel 0") as Group | null;
  const dataset = ch0 ? openDataset(ch0) : null;
  const parsed = dataset
    ? parseImsDtype(dataset.dtype, dataset.metadata)
    : null;
  if (!parsed) {
    const label = describeImsDtype(dataset?.dtype, dataset?.metadata);
    reasons.push(
      `Data type ${label} is not supported (only uint8, uint16, or float32)`,
    );
  }
  const sizeZ = levelInfos[0]?.dimensions[2] ?? 0;
  if (sizeZ < 2) {
    reasons.push("IMS volume is not 3D (ImageSizeZ must be greater than 1)");
  }

  let voxelSpacing: [number, number, number] | undefined;
  const info = h5.get("DataSetInfo") as Group | null;
  const image = info?.get("Image") as Group | null;
  if (image && levelInfos[0]) {
    const [sx, sy, sz] = levelInfos[0].dimensions;
    const ext = (i: number) => {
      const min = attrNum(image, `ExtMin${i}`);
      const max = attrNum(image, `ExtMax${i}`);
      return min !== undefined && max !== undefined ? max - min : undefined;
    };
    const dx = ext(0);
    const dy = ext(1);
    const dz = ext(2);
    if (dx && dy && dz) {
      voxelSpacing = [dx / sx, dy / sy, dz / sz];
    }
  }

  const name = (image ? attrStr(image, "Name") : undefined) || "ims";

  const compression = dataset?.filters?.[0]?.name;

  return {
    name,
    dimensions: levelInfos[0]?.dimensions ?? [1, 1, 1],
    voxelSpacing,
    levels: levelInfos,
    bitDepth: parsed?.bitDepth ?? 8,
    isFloat: parsed?.isFloat ?? false,
    numChannels,
    compression,
    reasons,
  };
}

function assembleBrick(
  lod: number,
  bx: number,
  by: number,
  bz: number,
  channelIndex: number,
): {
  buffer: ArrayBuffer;
  min: number;
  max: number;
  avg: number;
  rawMin?: number;
  rawMax?: number;
  fetchMs: number;
} {
  if (!file) throw new Error("IMS worker not initialized");
  const level = levels[lod];
  if (!level) throw new Error(`IMS LOD ${lod} not found`);
  const [dimX, dimY, dimZ] = level.dimensions;
  const ds = file.get("DataSet") as Group;
  const resName = resolutionGroupName(ds, lod);
  if (!resName) throw new Error(`IMS ResolutionLevel ${lod} missing`);
  const time0 = (ds.get(resName) as Group).get("TimePoint 0") as Group | null;
  const ch = time0?.get(`Channel ${channelIndex}`) as Group | null;
  if (!ch) {
    throw new Error(`IMS Channel ${channelIndex} missing at LOD ${lod}`);
  }
  const dataset = openDataset(ch);

  const vStartX = bx * LOGICAL - 1;
  const vStartY = by * LOGICAL - 1;
  const vStartZ = bz * LOGICAL - 1;
  const x0 = Math.max(0, vStartX);
  const y0 = Math.max(0, vStartY);
  const z0 = Math.max(0, vStartZ);
  const x1 = Math.min(dimX, vStartX + PHYSICAL);
  const y1 = Math.min(dimY, vStartY + PHYSICAL);
  const z1 = Math.min(dimZ, vStartZ + PHYSICAL);

  const downsampleTo8 = is16bit && !isFloat && targetFormat === "r8unorm";
  const brick: Uint8Array | Uint16Array =
    is16bit && !downsampleTo8
      ? new Uint16Array(PHYSICAL * PHYSICAL * PHYSICAL)
      : new Uint8Array(PHYSICAL * PHYSICAL * PHYSICAL);

  if (x1 <= x0 || y1 <= y0 || z1 <= z0) {
    return {
      buffer: brick.buffer as ArrayBuffer,
      min: 0,
      max: 0,
      avg: 0,
      fetchMs: 0,
    };
  }

  const t0 = performance.now();
  const sliced = dataset.slice([
    [z0, z1],
    [y0, y1],
    [x0, x1],
  ]);
  const fetchMs = performance.now() - t0;
  const plane = sliced as ArrayLike<number>;
  const strideX = x1 - x0;
  const strideY = y1 - y0;

  const u16ToF16Lut =
    is16bit && !isFloat && !downsampleTo8 ? getUint16ToFloat16Lut() : null;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let rawMinVal = Infinity;
  let rawMaxVal = -Infinity;

  const clamp = (v: number, lo: number, hi: number) =>
    hi <= lo ? lo : Math.max(lo, Math.min(hi - 1, v));

  for (let lz = 0; lz < PHYSICAL; lz++) {
    const gz = clamp(vStartZ + lz, z0, z1);
    const brickZBase = lz * PHYSICAL * PHYSICAL;
    const zOff = (gz - z0) * strideY * strideX;
    for (let ly = 0; ly < PHYSICAL; ly++) {
      const gy = clamp(vStartY + ly, y0, y1);
      const brickYZBase = brickZBase + ly * PHYSICAL;
      const row = zOff + (gy - y0) * strideX;
      for (let lx = 0; lx < PHYSICAL; lx++) {
        const gx = clamp(vStartX + lx, x0, x1);
        const raw = plane[row + (gx - x0)] ?? 0;
        let brickVal: number;
        let statVal: number;
        if (isFloat) {
          const range = floatMax - floatMin;
          const normalized =
            range > 0 ? Math.max(0, Math.min(1, (raw - floatMin) / range)) : 0;
          statVal = Math.round(normalized * 65535);
          brickVal = float32ToFloat16Bits(
            Math.max(-65504, Math.min(65504, raw)),
          );
          if (Number.isFinite(raw)) {
            if (raw < rawMinVal) rawMinVal = raw;
            if (raw > rawMaxVal) rawMaxVal = raw;
          }
        } else if (downsampleTo8) {
          brickVal = (raw as number) >> 8;
          statVal = raw;
        } else {
          brickVal = u16ToF16Lut?.[raw as number] ?? raw;
          statVal = raw;
        }
        brick[brickYZBase + lx] = brickVal;
        if (statVal < min) min = statVal;
        if (statVal > max) max = statVal;
        sum += statVal;
      }
    }
  }

  return {
    buffer: brick.buffer as ArrayBuffer,
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    avg: sum / (PHYSICAL * PHYSICAL * PHYSICAL),
    rawMin: isFloat && Number.isFinite(rawMinVal) ? rawMinVal : undefined,
    rawMax: isFloat && Number.isFinite(rawMaxVal) ? rawMaxVal : undefined,
    fetchMs,
  };
}

const ctx = self as unknown as Worker;

ctx.onmessage = (event: MessageEvent<ImsWorkerRequest>) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }

  const reply = (resp: ImsWorkerResponse) => {
    if (resp.data) {
      ctx.postMessage(resp, [resp.data]);
    } else {
      ctx.postMessage(resp);
    }
  };

  if (msg.type === "init") {
    void (async () => {
      try {
        await h5wasm.ready;
        if (!FS) throw new Error("h5wasm filesystem is unavailable");
        const source = "file" in msg ? { file: msg.file } : { url: msg.url };
        lazy = createRangeLazyFile(FS as never, FILE_NAME, source);
        file = new h5wasm.File(`/${FILE_NAME}`, "r");
        const metadata = readMetadata(file);
        levels = metadata.levels;
        is16bit = metadata.bitDepth === 16;
        isFloat = metadata.isFloat;
        reply({ type: "init", id: msg.id, metadata });
      } catch (e) {
        reply({
          type: "init",
          id: msg.id,
          error: e instanceof Error ? e.message : "IMS init failed",
        });
      }
    })();
    return;
  }

  if (msg.type === "setTargetFormat") {
    targetFormat = msg.targetFormat;
    reply({ type: "setTargetFormat", id: msg.id });
    return;
  }

  if (msg.type === "setFloatRange") {
    floatMin = msg.floatMin;
    floatMax = msg.floatMax;
    reply({ type: "setFloatRange", id: msg.id });
    return;
  }

  if (msg.type === "loadBrick") {
    if (cancelled.has(msg.id)) {
      cancelled.delete(msg.id);
      reply({
        type: "loadBrick",
        id: msg.id,
        error: "Aborted",
      });
      return;
    }
    try {
      const queueMs = Date.now() - msg.dispatchTime;
      const t1 = performance.now();
      const result = assembleBrick(
        msg.lod,
        msg.bx,
        msg.by,
        msg.bz,
        msg.channelIndex,
      );
      reply({
        type: "loadBrick",
        id: msg.id,
        data: result.buffer,
        min: result.min,
        max: result.max,
        avg: result.avg,
        rawMin: result.rawMin,
        rawMax: result.rawMax,
        fetchMs: result.fetchMs,
        assemblyMs: performance.now() - t1 - result.fetchMs,
        queueMs,
        chunkStoreBytes: lazy?.totalFetchedBytes,
        chunkStoreRequests: lazy?.totalRequests,
      });
    } catch (e) {
      reply({
        type: "loadBrick",
        id: msg.id,
        error: e instanceof Error ? e.message : "loadBrick failed",
      });
    }
  }
};
