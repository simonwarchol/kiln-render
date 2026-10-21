/** Dev-only GPU self-tests (open /app/gpu-tests.html). Results also on window.__gpuTests. */

import {
  type Blend,
  backwardReference,
  intrinsicsFor,
  PARAM_STRIDE,
  renderReference,
} from "@kiln/splat/cpu-reference.js";
import { readBuffer, STORAGE_RW } from "@kiln/splat/gpu/kernel.js";
import { GpuRadixSort } from "@kiln/splat/gpu/radix-sort.js";
import { SplatRasterizer } from "@kiln/splat/gpu/rasterizer.js";
import { GpuScan } from "@kiln/splat/gpu/scan.js";
import { SsimLoss } from "@kiln/splat/gpu/ssim.js";
import { GpuGaussians, SplatTrainStep } from "@kiln/splat/gpu/trainer.js";
import { ssimReference } from "@kiln/splat/ssim-reference.js";
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
  blend: Blend = "alpha",
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
  r.blend = blend;
  r.resize(w, h);
  r.setGaussians(pbuf, count);
  const enc = device.createCommandEncoder();
  r.encodeForward(enc, { ...cam, view: Float32Array.from(view) });
  device.queue.submit([enc.finish()]);
  const gpu = new Float32Array(
    await readBuffer(device, r.image, 0, w * h * 16),
  );
  const cpu = renderReference(params, count, cam, blend);
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
    `forward${blend === "max" ? " (max blend)" : ""} vs CPU n=${count} ${w}x${h}`,
    maxDiff < 2e-3 && sumA > 1,
    `max |diff| ${maxDiff.toExponential(2)} at px ${Math.floor(at / 4)} ch ${at % 4} (gpu ${gpu[at]?.toFixed(4)} cpu ${cpu.image[at]?.toFixed(4)}); coverage ${sumA.toFixed(0)}; isects ${m}`,
  );
  r.destroy();
  pbuf.destroy();
}

async function testBackward(
  device: GPUDevice,
  count: number,
  w: number,
  h: number,
  blend: Blend = "alpha",
): Promise<void> {
  const params = randomScene(count, count + 11);
  const view = mat4.lookAt([-0.6, 0.3, 1.5], [0, 0, 0], [0, -1, 0]);
  const cam = intrinsicsFor(Array.from(view), w, h);
  const gs = new GpuGaussians(device, params, count);
  const r = new SplatRasterizer(device);
  r.blend = blend;
  const tex = device.createTexture({
    size: [w, h, 1],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const step = new SplatTrainStep(r, gs, {
    texture: tex,
    cameras: [{ ...cam, view: Float32Array.from(view) }],
    width: w,
    height: h,
  });
  r.setGaussians(gs.params, count);
  const dImage = new Float32Array(w * h * 4);
  for (let i = 0; i < dImage.length; i++) dImage[i] = Math.sin(i * 0.37) * 0.5;
  device.queue.writeBuffer(step.dImage, 0, dImage);
  const enc = device.createCommandEncoder();
  r.encodeForward(enc, { ...cam, view: Float32Array.from(view) });
  step.encodeBackwardOnly(enc);
  device.queue.submit([enc.finish()]);
  const gpu = new Float32Array(
    await readBuffer(device, gs.grads, 0, count * PARAM_STRIDE * 4),
  );
  const cpu = backwardReference(
    params,
    count,
    cam,
    dImage,
    renderReference(params, count, cam, blend),
  );
  let worst = 0;
  let worstAt = "";
  let maxMag = 0;
  for (let g = 0; g < count; g++) {
    for (let k = 0; k < 14; k++) {
      const i = g * PARAM_STRIDE + k;
      const a = gpu[i]!;
      const b = cpu[i]!;
      maxMag = Math.max(maxMag, Math.abs(b));
      const rel = Math.abs(a - b) / Math.max(1e-3, Math.abs(b));
      if (rel > worst) {
        worst = rel;
        worstAt = `g${g}[${k}] gpu ${a.toExponential(3)} cpu ${b.toExponential(3)}`;
      }
    }
  }
  log(
    `backward${blend === "max" ? " (max blend)" : ""} vs CPU n=${count} ${w}x${h}`,
    worst < 2e-2,
    `worst rel err ${worst.toExponential(2)} (${worstAt}); max |grad| ${maxMag.toExponential(2)}`,
  );
  step.destroy();
  gs.destroy();
  r.destroy();
  tex.destroy();
}

async function testTraining(device: GPUDevice): Promise<void> {
  const count = 300;
  const w = 128;
  const h = 96;
  const gt = randomScene(count, 99);
  const nViews = 12;
  const views: Array<
    ReturnType<typeof intrinsicsFor> & { view: Float32Array }
  > = [];
  for (let i = 0; i < nViews; i++) {
    const a = (i / nViews) * Math.PI * 2;
    const el = 0.4 * Math.sin(i * 1.7);
    const eye: [number, number, number] = [
      1.6 * Math.cos(a) * Math.cos(el),
      1.6 * Math.sin(el),
      1.6 * Math.sin(a) * Math.cos(el),
    ];
    const view = Float32Array.from(mat4.lookAt(eye, [0, 0, 0], [0, -1, 0]));
    views.push({ ...intrinsicsFor(view, w, h), view });
  }
  const tex = device.createTexture({
    size: [w, h, nViews],
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const gtGs = new GpuGaussians(device, gt, count);
  const r = new SplatRasterizer(device);
  r.resize(w, h);
  r.setGaussians(gtGs.params, count);
  for (let i = 0; i < nViews; i++) {
    const enc = device.createCommandEncoder();
    r.encodeForward(enc, views[i]!);
    enc.copyBufferToTexture(
      { buffer: r.image, bytesPerRow: w * 16 },
      { texture: tex, origin: [0, 0, i] },
      [w, h, 1],
    );
    device.queue.submit([enc.finish()]);
  }
  // Perturbed initialisation
  const init = gt.slice();
  let seed = 5;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let g = 0; g < count; g++) {
    const b = g * PARAM_STRIDE;
    const jitter = (k: number, amt: number) => {
      init[b + k] = init[b + k]! + rnd() * amt;
    };
    for (let k = 0; k < 3; k++) jitter(k, 0.04);
    for (let k = 3; k < 6; k++) jitter(k, 0.6);
    for (let k = 10; k < 13; k++) jitter(k, 3);
    jitter(13, 2);
  }
  const gs = new GpuGaussians(device, init, count);
  const step = new SplatTrainStep(r, gs, {
    texture: tex,
    cameras: views,
    width: w,
    height: h,
  });
  const lrs = {
    mean: 2e-4,
    scale: 5e-3,
    quat: 1e-3,
    color: 2.5e-2,
    opacity: 2.5e-2,
  };
  const losses: number[] = [];
  const t0 = performance.now();
  const iters = 600;
  for (let it = 0; it < iters; it++) {
    const enc = device.createCommandEncoder();
    step.encodeStep(enc, it % nViews, lrs);
    device.queue.submit([enc.finish()]);
    if ((it + 1) % 100 === 0) losses.push((await step.takeLoss()) / 100);
  }
  await device.queue.onSubmittedWorkDone();
  const ms = (performance.now() - t0) / iters;
  const first = losses[0]!;
  const lastL = losses[losses.length - 1]!;
  log(
    "training converges (synthetic)",
    lastL < first * 0.5,
    `loss per 100 its: ${losses.map((l) => l.toExponential(2)).join(" → ")}; ${ms.toFixed(2)} ms/step`,
  );
  step.destroy();
  gs.destroy();
  gtGs.destroy();
  r.destroy();
  tex.destroy();
}

function denseSlab(count: number, seed = 3): Float32Array {
  let a = seed;
  const rand = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  const p = new Float32Array(count * PARAM_STRIDE);
  for (let g = 0; g < count; g++) {
    const b = g * PARAM_STRIDE;
    p[b] = rand() - 0.5;
    p[b + 1] = rand() - 0.5;
    p[b + 2] = (rand() - 0.5) * 0.1;
    const s = Math.log(0.0015 + rand() * 0.002);
    p[b + 3] = s;
    p[b + 4] = s;
    p[b + 5] = s - 0.5;
    p[b + 6] = 1;
    p[b + 7] = rand() - 0.5;
    p[b + 8] = rand() - 0.5;
    p[b + 9] = rand() - 0.5;
    p[b + 10] = (rand() - 0.5) * 2;
    p[b + 11] = (rand() - 0.5) * 2;
    p[b + 12] = (rand() - 0.5) * 2;
    p[b + 13] = -2.5 + rand();
  }
  return p;
}

async function benchTraining(
  device: GPUDevice,
  count: number,
  size: number,
): Promise<void> {
  const params = denseSlab(count);
  const view = Float32Array.from(
    mat4.lookAt([0.3, -0.9, 0.9], [0, 0, 0], [0, -1, 0]),
  );
  const cam = { ...intrinsicsFor(view, size, size), view };
  const tex = device.createTexture({
    size: [size, size, 1],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const gs = new GpuGaussians(device, params, count);
  const r = new SplatRasterizer(device);
  const step = new SplatTrainStep(r, gs, {
    texture: tex,
    cameras: [cam],
    width: size,
    height: size,
  });
  r.setGaussians(gs.params, count);
  const time = async (fn: (e: GPUCommandEncoder) => void) => {
    const t0 = performance.now();
    const enc = device.createCommandEncoder();
    fn(enc);
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  };
  const fwd0 = await time((e) => r.encodeForward(e, cam));
  const m = await r.intersectionTotal();
  r.reserveIntersections(m);
  step.invalidate();
  const fwd = await time((e) => r.encodeForward(e, cam));
  const bwd = await time((e) => step.encodeBackwardOnly(e));
  const lrs = {
    mean: 1e-4,
    scale: 5e-3,
    quat: 1e-3,
    color: 5e-3,
    opacity: 2.5e-2,
  };
  const full = await time((e) => step.encodeStep(e, 0, lrs));
  log(
    `train bench n=${count} ${size}²`,
    true,
    `isects ${m} (cap ${r.intersectionCapacity}); forward ${fwd0.toFixed(0)}→${fwd.toFixed(0)} ms, backward ${bwd.toFixed(0)} ms, full step ${full.toFixed(0)} ms`,
  );
  step.destroy();
  gs.destroy();
  r.destroy();
  tex.destroy();
}

async function testSsim(device: GPUDevice): Promise<void> {
  const w = 48;
  const h = 37;
  const n = w * h * 4;
  const x = new Float32Array(n).map((_, i) => 0.5 + 0.3 * Math.sin(i * 0.7));
  const y = new Float32Array(n).map((_, i) => 0.5 + 0.3 * Math.cos(i * 0.31));
  const img = device.createBuffer({ size: n * 4, usage: STORAGE_RW });
  device.queue.writeBuffer(img, 0, x);
  const tex = device.createTexture({
    size: [w, h, 1],
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, y, { bytesPerRow: w * 16 }, [
    w,
    h,
    1,
  ]);
  const dImage = device.createBuffer({ size: n * 4, usage: STORAGE_RW });
  const loss = device.createBuffer({ size: 16, usage: STORAGE_RW });
  const ssim = new SsimLoss(device, w, h, tex, dImage, loss);
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  ssim.encode(pass, img, 0, 0.2);
  pass.end();
  device.queue.submit([enc.finish()]);
  const gpu = new Float32Array(await readBuffer(device, dImage, 0, n * 4));
  const gpuSsim = await ssim.readSsim();
  const cpu = ssimReference(x, y, w, h, 0.2);
  let worst = 0;
  let maxMag = 0;
  for (let i = 0; i < n; i++) {
    maxMag = Math.max(maxMag, Math.abs(cpu.grad[i]!));
    worst = Math.max(worst, Math.abs(gpu[i]! - cpu.grad[i]!));
  }
  const ok = worst < maxMag * 1e-3 && Math.abs(gpuSsim - cpu.ssim) < 1e-4;
  log(
    "SSIM vs CPU",
    ok,
    `ssim gpu ${gpuSsim.toFixed(5)} cpu ${cpu.ssim.toFixed(5)}; grad max |diff| ${worst.toExponential(2)} (max |grad| ${maxMag.toExponential(2)})`,
  );
  ssim.destroy();
  img.destroy();
  tex.destroy();
  dImage.destroy();
  loss.destroy();
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
  await testBackward(device, 1, 64, 48);
  await testBackward(device, 30, 96, 64);
  await testBackward(device, 300, 133, 101);
  await testForward(device, 50, 96, 64, "max");
  await testForward(device, 400, 133, 101, "max");
  await testBackward(device, 30, 96, 64, "max");
  await testBackward(device, 300, 133, 101, "max");
  await testTraining(device);
  await testSsim(device);
  if (new URLSearchParams(location.search).has("bench")) {
    await benchTraining(device, 100_000, 512);
    await benchTraining(device, 300_000, 512);
    await benchTraining(device, 1_000_000, 512);
  }
  await benchForward(device, 1_000_000, 1280, 800);
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
