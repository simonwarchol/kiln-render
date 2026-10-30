/**
 * Perf logging only: GPU time per stage of a frame, from timestamp queries
 * (the optional "timestamp-query" feature, requested only while perf logging
 * is on). Each stage is a pass of its own. Chrome rounds timestamps to 0.1 ms
 * unless chrome://flags "WebGPU Developer Features" is on.
 */

import { perfSample } from "../../utils/perf-log.js";

const MAX_STAGES = 12;

export class GpuStageTimer {
  private readonly querySet: GPUQuerySet;
  private readonly resolved: GPUBuffer;
  private readonly readback: GPUBuffer;
  private names: string[] = [];
  /** A frame is being timed or read back. */
  private busy = false;

  constructor(
    device: GPUDevice,
    /** Prefix of the logged sample names */
    private readonly prefix: string,
  ) {
    this.querySet = device.createQuerySet({
      type: "timestamp",
      count: MAX_STAGES * 2,
    });
    this.resolved = device.createBuffer({
      label: "perf:timestamps",
      size: MAX_STAGES * 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readback = device.createBuffer({
      label: "perf:timestamps-read",
      size: MAX_STAGES * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  /** Whether the device can time passes. */
  static supported(device: GPUDevice): boolean {
    return device.features.has("timestamp-query");
  }

  /** Time this frame: false while the last one is still being read. */
  begin(): boolean {
    if (this.busy) return false;
    this.busy = true;
    this.names = [];
    return true;
  }

  /** Timestamp writes for the frame's next stage (one compute or render pass). */
  stage(name: string): GPUComputePassTimestampWrites {
    const i = Math.min(this.names.length, MAX_STAGES - 1);
    this.names[i] = name;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 2 * i,
      endOfPassWriteIndex: 2 * i + 1,
    };
  }

  /** Resolve the frame's timestamps: last on its encoder. */
  end(encoder: GPUCommandEncoder): void {
    const n = this.names.length * 2;
    if (n === 0) return;
    encoder.resolveQuerySet(this.querySet, 0, n, this.resolved, 0);
    encoder.copyBufferToBuffer(this.resolved, 0, this.readback, 0, n * 8);
  }

  /** After the frame is submitted: log each stage's GPU time. */
  read(): void {
    const names = this.names;
    if (names.length === 0) {
      this.busy = false;
      return;
    }
    this.readback
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const t = new BigUint64Array(
          this.readback.getMappedRange(),
          0,
          names.length * 2,
        );
        let total = 0;
        names.forEach((name, i) => {
          const ms = Number(t[2 * i + 1]! - t[2 * i]!) / 1e6;
          total += ms;
          perfSample(`${this.prefix} ${name}`, ms);
        });
        perfSample(`${this.prefix} all stages`, total);
        this.readback.unmap();
      })
      .catch(() => {})
      .finally(() => {
        this.busy = false;
      });
  }

  destroy(): void {
    this.querySet.destroy();
    this.resolved.destroy();
    this.readback.destroy();
  }
}
