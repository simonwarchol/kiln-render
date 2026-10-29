/**
 * Saved Imaris chunk indexes ("<file>.ims.index"), so a viewer can skip the
 * HDF5 chunk B-trees: hundreds of scattered small reads per channel and
 * level in a large file.
 *
 * Layout: magic "KILN-IDX", u32 version, u32 header length, the JSON
 * header, then per dataset (8-byte aligned) its chunk addresses
 * (Float64Array, -1 = unallocated) and stored sizes (Uint32Array) over its
 * chunk grid, x fastest. Little-endian, as typed arrays are on every
 * platform this runs on. The header lists each dataset's chunk-index file
 * address: a table is used only for a dataset whose index is still there.
 */

import {
  Hdf5Dataset,
  type Hdf5File,
  Hdf5Group,
  type RangeSource,
} from "../hdf5/index.js";

type Vec3 = [number, number, number];

/** A dataset's chunks as flat arrays over its chunk grid, x fastest. */
export interface ChunkTable {
  /** chunk shape [x, y, z] */
  chunkShape: Vec3;
  /** chunk grid [x, y, z] */
  grid: Vec3;
  /** File address per chunk; -1 when unallocated (reads as zeros) */
  address: Float64Array;
  /** Stored (compressed) bytes per chunk */
  size: Uint32Array;
  /** The rare non-zero filter masks */
  filterMask: Map<number, number>;
}

const MAGIC = "KILN-IDX";
const VERSION = 1;
/** Enough for the header of a file with hundreds of datasets. */
const HEAD_READ = 64 * 1024;

interface Entry {
  level: number;
  channel: number;
  indexAddress: number;
  chunkShape: Vec3;
  grid: Vec3;
  /** Byte offset of the dataset's tables */
  offset: number;
  filterMask: [number, number][];
}

interface Header {
  timepoint: number;
  datasets: Entry[];
}

/** Chunk shape and grid [x, y, z] of a (z, y, x) dataset. */
function gridOf(ds: Hdf5Dataset): { chunkShape: Vec3; grid: Vec3 } {
  const cs = ds.chunkShape ?? ds.shape;
  const chunkShape: Vec3 = [cs[2]!, cs[1]!, cs[0]!];
  const grid: Vec3 = [
    Math.ceil(ds.shape[2]! / chunkShape[0]),
    Math.ceil(ds.shape[1]! / chunkShape[1]),
    Math.ceil(ds.shape[0]! / chunkShape[2]),
  ];
  return { chunkShape, grid };
}

/** The dataset's chunk table, from its chunk index in the file. */
export async function readChunkTable(ds: Hdf5Dataset): Promise<ChunkTable> {
  const { chunkShape, grid } = gridOf(ds);
  const n = grid[0] * grid[1] * grid[2];
  const table: ChunkTable = {
    chunkShape,
    grid,
    address: new Float64Array(n).fill(-1),
    size: new Uint32Array(n),
    filterMask: new Map(),
  };
  if (!ds.chunkShape) return table;
  for (const ref of await ds.chunks()) {
    const i =
      (Math.floor(ref.offset[0]! / chunkShape[2]) * grid[1] +
        Math.floor(ref.offset[1]! / chunkShape[1])) *
        grid[0] +
      Math.floor(ref.offset[2]! / chunkShape[0]);
    if (i >= n) continue;
    table.address[i] = ref.address;
    table.size[i] = ref.size;
    if (ref.filterMask !== 0) table.filterMask.set(i, ref.filterMask);
  }
  return table;
}

const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const align8 = (n: number) => Math.ceil(n / 8) * 8;

/** A saved index file, read lazily: its header, then a dataset's tables when asked. */
export class ChunkIndexFile {
  private constructor(
    private readonly src: RangeSource,
    private readonly header: Header,
    private readonly entries: Map<string, Entry>,
  ) {}

  /** The index file behind `src`; null if it isn't one (or can't be read). */
  static async open(src: RangeSource): Promise<ChunkIndexFile | null> {
    try {
      let head = await src.read(0, HEAD_READ);
      if (head.length < 16) return null;
      if (new TextDecoder().decode(head.subarray(0, 8)) !== MAGIC) return null;
      const view = new DataView(head.buffer, head.byteOffset, head.length);
      if (view.getUint32(8, true) !== VERSION) return null;
      const length = view.getUint32(12, true);
      if (16 + length > head.length) head = await src.read(0, 16 + length);
      const header = JSON.parse(
        new TextDecoder().decode(head.subarray(16, 16 + length)),
      ) as Header;
      const entries = new Map(
        header.datasets.map((e) => [`${e.level}:${e.channel}`, e]),
      );
      return new ChunkIndexFile(src, header, entries);
    } catch {
      return null;
    }
  }

  /**
   * The table saved for this dataset, if there is one for its current
   * chunk layout (otherwise read the file's own index).
   */
  async table(
    level: number,
    channel: number,
    timepoint: number,
    ds: Hdf5Dataset,
  ): Promise<ChunkTable | null> {
    const e = this.entries.get(`${level}:${channel}`);
    const { chunkShape, grid } = gridOf(ds);
    if (
      !e ||
      timepoint !== this.header.timepoint ||
      e.indexAddress !== ds.chunkIndexAddress ||
      !same(e.chunkShape, chunkShape) ||
      !same(e.grid, grid)
    ) {
      return null;
    }
    const n = grid[0] * grid[1] * grid[2];
    let bytes = await this.src.read(e.offset, n * 12);
    if (bytes.length < n * 12) return null;
    if (bytes.byteOffset % 8 !== 0) bytes = bytes.slice();
    return {
      chunkShape,
      grid,
      address: new Float64Array(bytes.buffer, bytes.byteOffset, n).slice(),
      size: new Uint32Array(bytes.buffer, bytes.byteOffset + n * 8, n).slice(),
      filterMask: new Map(e.filterMask),
    };
  }
}

/** Encode chunk tables as an index file. */
export function encodeChunkIndex(
  timepoint: number,
  tables: Array<{
    level: number;
    channel: number;
    indexAddress: number;
    table: ChunkTable;
  }>,
): Uint8Array {
  const datasets: Entry[] = tables.map(
    ({ level, channel, indexAddress, table }) => ({
      level,
      channel,
      indexAddress,
      chunkShape: table.chunkShape,
      grid: table.grid,
      offset: 0,
      filterMask: [...table.filterMask],
    }),
  );
  const enc = new TextEncoder();
  const headerBytes = () =>
    enc.encode(JSON.stringify({ timepoint, datasets } satisfies Header));
  // The tables follow the header, whose length depends on their offsets:
  // place them until the header no longer grows past its 8-byte slot.
  let header = headerBytes();
  let size = 0;
  for (;;) {
    let at = align8(16 + header.length);
    for (const [i, { table }] of tables.entries()) {
      datasets[i]!.offset = at;
      at = align8(at + table.address.length * 12);
    }
    size = at;
    const next = headerBytes();
    const settled = align8(16 + next.length) === align8(16 + header.length);
    header = next;
    if (settled) break;
  }
  const out = new Uint8Array(size);
  out.set(enc.encode(MAGIC), 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, VERSION, true);
  view.setUint32(12, header.length, true);
  out.set(header, 16);
  for (const [i, { table }] of tables.entries()) {
    const at = datasets[i]!.offset;
    const n = table.address.length;
    new Float64Array(out.buffer, at, n).set(table.address);
    new Uint32Array(out.buffer, at + n * 8, n).set(table.size);
  }
  return out;
}

/** Sorted N of the "<prefix> N" names in a group. */
async function numbered(group: Hdf5Group, prefix: RegExp): Promise<number[]> {
  return (await group.keys())
    .map((k) => prefix.exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

/**
 * An index file for every resolution level of `channels` (default: all) in
 * an open Imaris file. Reads each dataset's chunk B-tree once.
 */
export async function buildImsChunkIndex(
  file: Hdf5File,
  opts: {
    timepoint?: number;
    channels?: readonly number[];
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<Uint8Array> {
  const timepoint = opts.timepoint ?? 0;
  const dataSet = await file.get("/DataSet");
  if (!(dataSet instanceof Hdf5Group)) {
    throw new Error("Not an Imaris file (missing /DataSet)");
  }
  const levels = await numbered(dataSet, /^Resolution ?Level (\d+)$/);
  const tp = await file.get(
    `/DataSet/ResolutionLevel ${levels[0]}/TimePoint ${timepoint}`,
  );
  if (!(tp instanceof Hdf5Group)) {
    throw new Error(`Imaris time point ${timepoint} missing`);
  }
  const channels = opts.channels ?? (await numbered(tp, /^Channel (\d+)$/));
  const total = levels.length * channels.length;
  let done = 0;
  const tables: Parameters<typeof encodeChunkIndex>[1] = [];
  for (const level of levels) {
    // A level's channels together: their B-tree reads overlap.
    const got = await Promise.all(
      channels.map(async (channel) => {
        const ds = await file.get(
          `/DataSet/ResolutionLevel ${level}/TimePoint ${timepoint}/Channel ${channel}/Data`,
        );
        const indexAddress =
          ds instanceof Hdf5Dataset ? ds.chunkIndexAddress : null;
        if (!(ds instanceof Hdf5Dataset) || indexAddress === null) return null;
        const table = await readChunkTable(ds);
        opts.onProgress?.(++done, total);
        return { level, channel, indexAddress, table };
      }),
    );
    for (const t of got) if (t) tables.push(t);
  }
  return encodeChunkIndex(timepoint, tables);
}
