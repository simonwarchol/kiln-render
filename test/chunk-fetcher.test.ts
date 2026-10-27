import { describe, expect, it, vi } from "vitest";
import type { RangeSource } from "../src/data/hdf5/source.js";
import { ChunkFetcher } from "../src/data/imaris/chunk-fetcher.js";

/** Range source whose reads complete only when the test says so. */
function manualSource() {
  const reads: Array<{ offset: number; length: number; done: () => void }> = [];
  const source: RangeSource = {
    read(offset, length) {
      return new Promise((resolve) =>
        reads.push({
          offset,
          length,
          done: () =>
            resolve(Uint8Array.from({ length }, (_, i) => (offset + i) & 0xff)),
        }),
      );
    },
  };
  return { source, reads };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const chunk = (address: number, size = 100) => ({ address, size });

describe("ChunkFetcher", () => {
  it("reads the most urgent chunks first", async () => {
    const { source, reads } = manualSource();
    const f = new ChunkFetcher(source, { maxConcurrent: 1, maxGap: 0 });
    void f.get(chunk(0), undefined, 5);
    void f.get(chunk(1000), undefined, 1);
    void f.get(chunk(2000), undefined, 3);
    await tick();
    expect(reads.map((r) => r.offset)).toEqual([1000]);
    reads[0]!.done();
    await tick();
    expect(reads.map((r) => r.offset)).toEqual([1000, 2000]);
    reads[1]!.done();
    await tick();
    expect(reads.map((r) => r.offset)).toEqual([1000, 2000, 0]);
  });

  it("raises a queued chunk's priority when a more urgent brick asks", async () => {
    const { source, reads } = manualSource();
    const f = new ChunkFetcher(source, { maxConcurrent: 1, maxGap: 0 });
    void f.get(chunk(0), undefined, 1);
    void f.get(chunk(1000), undefined, 5);
    void f.get(chunk(2000), undefined, 3);
    await tick();
    void f.get(chunk(1000), undefined, 0);
    reads[0]!.done();
    await tick();
    expect(reads.map((r) => r.offset)).toEqual([0, 1000]);
  });

  it("groups adjacent chunks when a connection frees up", async () => {
    const { source, reads } = manualSource();
    const f = new ChunkFetcher(source, { maxConcurrent: 1, maxGap: 10 });
    const first = f.get(chunk(5000), undefined, 0);
    await tick();
    // Queued while the only connection is busy, then read as one range.
    const a0 = f.get(chunk(0), undefined, 1);
    const a1 = f.get(chunk(105), undefined, 1);
    const b = f.get(chunk(210), undefined, 1);
    reads[0]!.done();
    await first;
    await tick();
    expect(reads.slice(1).map((r) => [r.offset, r.length])).toEqual([[0, 310]]);
    reads[1]!.done();
    expect((await a0)[0]).toBe(0);
    expect((await a1)[0]).toBe(105);
    expect((await b)[0]).toBe(210);
    expect(reads).toHaveLength(2);
  });

  it("does not delay an urgent chunk with much less urgent neighbours", async () => {
    const { source, reads } = manualSource();
    const f = new ChunkFetcher(source, { maxConcurrent: 1, maxGap: 10 });
    void f.get(chunk(0), undefined, 0);
    void f.get(chunk(100), undefined, 9);
    void f.get(chunk(5000), undefined, 1);
    await tick();
    expect(reads.map((r) => [r.offset, r.length])).toEqual([[0, 100]]);
  });

  it("skips chunks whose requesters all gave up", async () => {
    const { source, reads } = manualSource();
    const f = new ChunkFetcher(source, { maxConcurrent: 1, maxGap: 0 });
    void f.get(chunk(5000));
    const ctrl = new AbortController();
    const dropped = f.get(chunk(0), ctrl.signal, 0);
    await tick();
    ctrl.abort();
    reads[0]!.done();
    await expect(dropped).rejects.toThrow("cancelled");
    expect(reads).toHaveLength(1);
  });

  it("cancels queued reads on dispose", async () => {
    const { source, reads } = manualSource();
    const f = new ChunkFetcher(source, { maxConcurrent: 1, maxGap: 0 });
    const first = f.get(chunk(0));
    const queued = f.get(chunk(5000));
    await tick();
    f.dispose();
    await expect(queued).rejects.toThrow("cancelled");
    reads[0]!.done();
    await first;
    await tick();
    expect(reads).toHaveLength(1);
    await expect(f.get(chunk(9000))).rejects.toThrow("cancelled");
  });

  it("reports cached chunks", async () => {
    const { source, reads } = manualSource();
    const onCached = vi.fn();
    const f = new ChunkFetcher(source, { onCached });
    expect(f.has(0, 100)).toBe(false);
    const p = f.get(chunk(0));
    await tick();
    reads[0]!.done();
    await p;
    expect(f.has(0, 100)).toBe(true);
    expect(onCached).toHaveBeenCalledWith(0);
  });
});
