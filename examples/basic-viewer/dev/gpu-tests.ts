/** Dev-only GPU self-tests (open /app/gpu-tests.html). Results also on window.__gpuTests. */

import { trainWithBrush } from "@kiln/splat/brush-trainer.js";
import { cloudFromParams } from "@kiln/splat/cloud.js";
import {
  intrinsicsFor,
  PARAM_STRIDE,
  renderReference,
  type SplatCamera,
} from "@kiln/splat/cpu-reference.js";
import {
  createBuffer,
  readBuffer,
  STORAGE_RW,
} from "@kiln/splat/gpu/kernel.js";
import { GpuRadixSort } from "@kiln/splat/gpu/radix-sort.js";
import { SplatRasterizer } from "@kiln/splat/gpu/rasterizer.js";
import { GpuScan } from "@kiln/splat/gpu/scan.js";
import { evaluateCloud, sphereDirections } from "@kiln/splat/splat-builder.js";
import { float32ToFloat16Array } from "@kiln/utils/float16.js";
import { mat4 } from "wgpu-matrix";

const logEl = document.getElementById("log")!;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
(window as unknown as { __gpuTests: unknown }).__gpuTests = results;

function log(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const span = document.createElement("span");
  span.className = ok ? "pass" : "fail";
  span.textContent = `${ok ? "PASS" : "FAIL"} ${name} — ${detail}\n`;
  logEl.appendChild(span);
}

function u32Buffer(device: GPUDevice, data: Uint32Array, extra = 0): GPUBuffer {
  const buf = device.createBuffer({
    size: Math.max(16, (data.length + extra) * 4),
    usage: STORAGE_RW,
  });
  device.queue.writeBuffer(buf, 0, data as Uint32Array<ArrayBuffer>);
  return buf;
}

async function testScan(device: GPUDevice, n: number): Promise<void> {
  const data = new Uint32Array(n);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 8) | 0;
  const buf = u32Buffer(device, data);
  const countBuf = u32Buffer(device, new Uint32Array([0, 0, n, 0]));
  const scan = new GpuScan(device, n);
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  scan.encode(pass, buf, { buffer: countBuf, index: 2 });
  pass.end();
  const t0 = performance.now();
  device.queue.submit([enc.finish()]);
  const out = new Uint32Array(await readBuffer(device, buf, 0, n * 4));
  const ms = performance.now() - t0;
  let run = 0;
  let bad = -1;
  for (let i = 0; i < n; i++) {
    if (out[i] !== run) {
      bad = i;
      break;
    }
    run += data[i]!;
  }
  log(
    `scan n=${n}`,
    bad < 0,
    bad < 0
      ? `${ms.toFixed(1)} ms incl. readback`
      : `mismatch at ${bad}: ${out[bad]} vs expected`,
  );
  scan.destroy();
  buf.destroy();
  countBuf.destroy();
}

async function testSort(
  device: GPUDevice,
  n: number,
  bits: number,
  cap = n,
): Promise<void> {
  const keys = new Uint32Array(n);
  const vals = new Uint32Array(n);
  const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
  for (let i = 0; i < n; i++) {
    keys[i] = ((Math.random() * 0x100000000) >>> 0) & mask;
    vals[i] = i;
  }
  const kb = u32Buffer(device, keys);
  const vb = u32Buffer(device, vals);
  const countBuf = u32Buffer(device, new Uint32Array([n]));
  const sorter = new GpuRadixSort(device, cap);
  const run = async () => {
    device.queue.writeBuffer(kb, 0, keys);
    device.queue.writeBuffer(vb, 0, vals);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    sorter.encode(pass, kb, vb, { buffer: countBuf, index: 0 }, bits);
    pass.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
  };
  await run();
  const t0 = performance.now();
  await run();
  const ms = performance.now() - t0;
  const outK = new Uint32Array(await readBuffer(device, kb, 0, n * 4));
  const outV = new Uint32Array(await readBuffer(device, vb, 0, n * 4));
  // Expected: stable sort by key
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => keys[a]! - keys[b]! || a - b);
  let bad = -1;
  for (let i = 0; i < n; i++) {
    if (outV[i] !== idx[i] || outK[i] !== keys[idx[i]!]) {
      bad = i;
      break;
    }
  }
  log(
    `radix sort n=${n} bits=${bits}`,
    bad < 0,
    bad < 0
      ? `${ms.toFixed(1)} ms (upload+sort)`
      : `mismatch at ${bad}: key ${outK[bad]} val ${outV[bad]} expected val ${idx[bad]}`,
  );
  sorter.destroy();
  kb.destroy();
  vb.destroy();
  countBuf.destroy();
}

function randomScene(count: number, seed = 1): Float32Array {
  let a = seed;
  const rand = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  const p = new Float32Array(count * PARAM_STRIDE);
  for (let g = 0; g < count; g++) {
    const b = g * PARAM_STRIDE;
    p[b] = (rand() - 0.5) * 0.8;
    p[b + 1] = (rand() - 0.5) * 0.6;
    p[b + 2] = (rand() - 0.5) * 0.8;
    p[b + 3] = Math.log(0.01 + rand() * 0.05);
    p[b + 4] = Math.log(0.01 + rand() * 0.05);
    p[b + 5] = Math.log(0.01 + rand() * 0.05);
    p[b + 6] = 0.5 + rand();
    p[b + 7] = rand() - 0.5;
    p[b + 8] = rand() - 0.5;
    p[b + 9] = rand() - 0.5;
    p[b + 10] = (rand() - 0.5) * 4;
    p[b + 11] = (rand() - 0.5) * 4;
    p[b + 12] = (rand() - 0.5) * 4;
    p[b + 13] = -1 + rand() * 3;
  }
  return p;
}

async function testForward(
  device: GPUDevice,
  count: number,
  w: number,
  h: number,
): Promise<void> {
  const params = randomScene(count, count);
  const pbuf = device.createBuffer({
    size: params.byteLength,
    usage: STORAGE_RW,
  });
  device.queue.writeBuffer(pbuf, 0, params as Float32Array<ArrayBuffer>);
  const view = mat4.lookAt([0.4, -0.5, 1.6], [0, 0, 0], [0, -1, 0]);
  const cam = intrinsicsFor(Array.from(view), w, h);
  const r = new SplatRasterizer(device);
  r.resize(w, h);
  r.setGaussians(pbuf, count);
  const enc = device.createCommandEncoder();
  r.encodeForward(enc, { ...cam, view: Float32Array.from(view) });
  device.queue.submit([enc.finish()]);
  const gpu = new Float32Array(
    await readBuffer(device, r.image, 0, w * h * 16),
  );
  const cpu = renderReference(params, count, cam);
  let maxDiff = 0;
  let at = -1;
  for (let i = 0; i < gpu.length; i++) {
    const d = Math.abs(gpu[i]! - cpu.image[i]!);
    if (d > maxDiff) {
      maxDiff = d;
      at = i;
    }
  }
  let sumA = 0;
  for (let i = 3; i < gpu.length; i += 4) sumA += gpu[i]!;
  const m = await r.intersectionTotal();
  const order = new Uint32Array(
    await readBuffer(device, r.depthIdx, 0, count * 4),
  );
  const cpuOrder = cpu.order;
  let firstMismatch = -1;
  for (let i = 0; i < cpuOrder.length; i++)
    if (order[i] !== cpuOrder[i]) {
      firstMismatch = i;
      break;
    }
  log(
    `depth order n=${count}`,
    firstMismatch < 0,
    firstMismatch < 0
      ? "matches CPU sort"
      : `first mismatch at ${firstMismatch} (gpu ${order[firstMismatch]} cpu ${cpuOrder[firstMismatch]})`,
  );
  log(
    `forward vs CPU n=${count} ${w}x${h}`,
    maxDiff < 2e-3 && sumA > 1,
    `max |diff| ${maxDiff.toExponential(2)} at px ${Math.floor(at / 4)} ch ${at % 4} (gpu ${gpu[at]?.toFixed(4)} cpu ${cpu.image[at]?.toFixed(4)}); coverage ${sumA.toFixed(0)}; isects ${m}`,
  );
  r.destroy();
  pbuf.destroy();
}

async function benchForward(
  device: GPUDevice,
  count: number,
  w: number,
  h: number,
): Promise<void> {
  const params = randomScene(count, 7);
  for (let g = 0; g < count; g++) {
    params[g * PARAM_STRIDE + 3] = Math.log(0.004);
    params[g * PARAM_STRIDE + 4] = Math.log(0.004);
    params[g * PARAM_STRIDE + 5] = Math.log(0.004);
  }
  const pbuf = device.createBuffer({
    size: params.byteLength,
    usage: STORAGE_RW,
  });
  device.queue.writeBuffer(pbuf, 0, params as Float32Array<ArrayBuffer>);
  const view = mat4.lookAt([0.4, -0.5, 1.6], [0, 0, 0], [0, -1, 0]);
  const cam = intrinsicsFor(Array.from(view), w, h);
  const r = new SplatRasterizer(device);
  r.resize(w, h);
  r.setGaussians(pbuf, count);
  const frame = async () => {
    const enc = device.createCommandEncoder();
    r.encodeForward(enc, { ...cam, view: Float32Array.from(view) });
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
  };
  await frame();
  const m = await r.intersectionTotal();
  r.reserveIntersections(m);
  await frame();
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) await frame();
  const ms = (performance.now() - t0) / 5;
  log(
    `forward bench n=${count} ${w}x${h}`,
    true,
    `${ms.toFixed(1)} ms/frame, ${m} intersections`,
  );
  r.destroy();
  pbuf.destroy();
}

/**
 * Per-channel clouds: additive mode must equal the sum of the channels drawn
 * separately (with tints applied), and a hidden channel must drop out.
 */
async function testChannelComposite(device: GPUDevice): Promise<void> {
  const w = 96;
  const h = 64;
  const n = 300;
  const a = randomScene(n, 21);
  const b = randomScene(n, 22);
  const view = Float32Array.from(
    mat4.lookAt([0.4, -0.5, 1.6], [0, 0, 0], [0, -1, 0]),
  );
  const cam = { ...intrinsicsFor(Array.from(view), w, h), view };
  const render = async (
    params: Float32Array,
    count: number,
    mode: 0 | 1 | 2,
    tint?: number[],
  ) => {
    const buf = createBuffer(device, "test:ch", params.byteLength, STORAGE_RW);
    device.queue.writeBuffer(buf, 0, params as Float32Array<ArrayBuffer>);
    const r = new SplatRasterizer(device);
    r.resize(w, h);
    r.setGaussians(buf, count);
    r.reserveIntersections(count * 64);
    r.channelMode = mode;
    if (tint) r.channelTint.set(tint);
    const enc = device.createCommandEncoder();
    r.encodeForward(enc, cam);
    device.queue.submit([enc.finish()]);
    const img = new Float32Array(
      await readBuffer(device, r.image, 0, w * h * 16),
    );
    r.destroy();
    buf.destroy();
    return img;
  };
  const both = new Float32Array(2 * n * PARAM_STRIDE);
  both.set(a, 0);
  both.set(b, n * PARAM_STRIDE);
  for (let i = 0; i < n; i++) both[(n + i) * PARAM_STRIDE + 14] = 1;
  const ia = await render(a, n, 0);
  const ib = await render(b, n, 0);
  const red = [1, 1, 1, 1, 1, 0, 0, 1, ...Array(16).fill(1)];
  const sum = await render(both, 2 * n, 2, red);
  const hidden = await render(both, 2 * n, 2, [
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    0,
    ...Array(16).fill(1),
  ]);
  let maxSum = 0;
  let maxHidden = 0;
  for (let p = 0; p < w * h; p++) {
    const tint = [1, 0, 0];
    for (let c = 0; c < 3; c++) {
      const want = ia[p * 4 + c]! + ib[p * 4 + c]! * tint[c]!;
      maxSum = Math.max(maxSum, Math.abs(sum[p * 4 + c]! - want));
      maxHidden = Math.max(
        maxHidden,
        Math.abs(hidden[p * 4 + c]! - ia[p * 4 + c]!),
      );
    }
    const alpha = 1 - (1 - ia[p * 4 + 3]!) * (1 - ib[p * 4 + 3]!);
    maxSum = Math.max(maxSum, Math.abs(sum[p * 4 + 3]! - alpha));
  }
  log(
    "per-channel additive composite (tint, hide)",
    maxSum < 2e-3 && maxHidden < 2e-3,
    `max |diff| sum ${maxSum.toExponential(2)}, hidden ${maxHidden.toExponential(2)}`,
  );
}

/**
 * Brush round trip: render a known cloud with Kiln's rasterizer from many
 * views, train Brush from that same cloud, and check it still matches. A
 * wrong camera, quaternion or colour convention would wreck the score.
 */
async function testBrush(
  device: GPUDevice,
  count: number,
  size: number,
  nViews: number,
  iterations: number,
): Promise<void> {
  const params = randomScene(count, 11);
  for (let g = 0; g < count; g++) params[g * PARAM_STRIDE + 6] = 1; // ~unit quats
  const pbuf = createBuffer(
    device,
    "test:brush",
    params.byteLength,
    STORAGE_RW,
  );
  device.queue.writeBuffer(pbuf, 0, params as Float32Array<ArrayBuffer>);
  const texture = device.createTexture({
    size: [size, size, nViews],
    format: "rgba16float",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC,
  });
  const r = new SplatRasterizer(device);
  r.mipFilter = true;
  r.resize(size, size);
  r.setGaussians(pbuf, count);
  r.reserveIntersections(count * 64);
  const cameras: SplatCamera[] = [];
  for (const [i, d] of sphereDirections(nViews).entries()) {
    const eye = [d[0] * 2.2, d[1] * 2.2, d[2] * 2.2];
    const up = Math.abs(d[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
    const view = Float32Array.from(mat4.lookAt(eye, [0, 0, 0], up));
    const cam = { ...intrinsicsFor(Array.from(view), size, size), view };
    cameras.push(cam);
    const enc = device.createCommandEncoder();
    r.encodeForward(enc, cam);
    device.queue.submit([enc.finish()]);
    const img = new Float32Array(
      await readBuffer(device, r.image, 0, size * size * 16),
    );
    device.queue.writeTexture(
      { texture, origin: [0, 0, i] },
      float32ToFloat16Array(img) as Uint16Array<ArrayBuffer>,
      { bytesPerRow: size * 8 },
      [size, size, 1],
    );
  }
  r.destroy();
  const views = { texture, cameras, width: size, height: size };
  const black = [0, 0, 0];
  const before = await evaluateCloud(device, pbuf, count, views, black);
  const t0 = performance.now();
  let error = "";
  let after = 0;
  let trained = 0;
  try {
    const cloud = await trainWithBrush(
      device,
      cloudFromParams(params, count),
      views,
      { iterations, maxSplats: count * 2 },
    );
    trained = cloud.count;
    const tbuf = createBuffer(
      device,
      "test:brush-out",
      cloud.params.byteLength,
      STORAGE_RW,
    );
    device.queue.writeBuffer(
      tbuf,
      0,
      cloud.params as Float32Array<ArrayBuffer>,
    );
    after = await evaluateCloud(device, tbuf, cloud.count, views, black);
    tbuf.destroy();
  } catch (e) {
    error = String((e as Error)?.stack ?? e);
  }
  texture.destroy();
  pbuf.destroy();
  log(
    `Brush round trip n=${count} ${nViews}×${size}² ${iterations} its`,
    !error && after > 25,
    error ||
      `PSNR ${before.toFixed(1)} dB (source) → ${after.toFixed(1)} dB (trained), ${trained} splats, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
}

async function main(): Promise<void> {
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("no adapter");
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has("subgroups") ? ["subgroups"] : [],
    requiredLimits: {
      maxStorageBuffersPerShaderStage:
        adapter.limits.maxStorageBuffersPerShaderStage,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  device.addEventListener("uncapturederror", (e) => {
    log(
      "uncaptured GPU error",
      false,
      (e as GPUUncapturedErrorEvent).error.message,
    );
  });
  // ?only=brush runs just the Brush round trip.
  if (new URLSearchParams(location.search).get("only") === "brush") {
    await testBrush(device, 2000, 128, 24, 300);
    logEl.appendChild(document.createTextNode("done\n"));
    return;
  }
  for (const n of [1, 1000, 1024, 1025, 70_000, 1_500_000])
    await testScan(device, n);
  await testSort(device, 1, 8);
  await testSort(device, 300, 16);
  await testSort(device, 100_000, 13);
  await testSort(device, 100_000, 32);
  await testSort(device, 1_000_000, 32);
  await testSort(device, 4_000_000, 16);
  await testSort(device, 5000, 32, 100_000);
  await testForward(device, 1, 64, 48);
  await testForward(device, 50, 96, 64);
  await testForward(device, 400, 133, 101);
  await testChannelComposite(device);
  await benchForward(device, 1_000_000, 1280, 800);
  await testBrush(device, 2000, 128, 24, 300);
  const tests =
    (
      window as unknown as {
        __gpuExtraTests?: Array<(d: GPUDevice, l: typeof log) => Promise<void>>;
      }
    ).__gpuExtraTests ?? [];
  for (const t of tests) await t(device, log);
  logEl.appendChild(document.createTextNode("done\n"));
}

main().catch((e) => log("main", false, String(e?.stack ?? e)));
