/**
 * WGSL for the tile-based Gaussian splat rasterizer (forward pass).
 * Mirrors src/splat/cpu-reference.ts — keep the two in sync.
 */

import { WGSL_LINEAR_WORKGROUP } from "./kernel.js";

export const TILE = 16;
export const PROJ_STRIDE = 12;

/** Camera uniform layout (bytes). */
export const CAMERA_UNIFORM_SIZE = 128;

export const RASTER_COMMON_WGSL = /* wgsl */ `
${WGSL_LINEAR_WORKGROUP}

const PARAM_STRIDE: u32 = 16u;
const PROJ_STRIDE: u32 = ${PROJ_STRIDE}u;
const TILE: u32 = ${TILE}u;
const ALPHA_MIN: f32 = ${1 / 255};
const ALPHA_MAX: f32 = 0.99;
const T_MIN: f32 = 0.0001;
const COV2D_DILATION: f32 = 0.3;
const NEAR_Z: f32 = 0.01;
const FRUSTUM_SLACK: f32 = 1.3;

struct Camera {
  view: mat4x4f,
  fx: f32,
  fy: f32,
  cx: f32,
  cy: f32,
  width: u32,
  height: u32,
  tilesX: u32,
  tilesY: u32,
  count: u32,
  isectCapacity: u32,
  scaleMul: f32,
  /** 1 = Mip-Splatting opacity compensation for the dilation (Kiln clouds) */
  mipFilter: u32,
}

fn sigmoid(x: f32) -> f32 { return 1.0 / (1.0 + exp(-x)); }

/** Row-major rotation entries packed as WGSL columns: R[col][row]. */
fn quatToRot(q: vec4f) -> mat3x3f {
  let w = q.x; let x = q.y; let y = q.z; let z = q.w;
  return mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)),
  );
}

struct Gaussian {
  mean: vec3f,
  logScale: vec3f,
  quat: vec4f,
  colorLogit: vec3f,
  opacityLogit: f32,
}

fn loadGaussian(g: u32) -> Gaussian {
  let b = g * PARAM_STRIDE;
  var out: Gaussian;
  out.mean = vec3f(params[b], params[b + 1u], params[b + 2u]);
  out.logScale = vec3f(params[b + 3u], params[b + 4u], params[b + 5u]);
  out.quat = vec4f(params[b + 6u], params[b + 7u], params[b + 8u], params[b + 9u]);
  out.colorLogit = vec3f(params[b + 10u], params[b + 11u], params[b + 12u]);
  out.opacityLogit = params[b + 13u];
  return out;
}

struct ProjInternals {
  visible: bool,
  uv: vec2f,
  conic: vec3f,
  depth: f32,
  radius: f32,
  /** Half-extents of the α ≥ ALPHA_MIN ellipse's bounding box (px) */
  extentXY: vec2f,
  color: vec3f,
  /** effective opacity o·ρ used for compositing */
  opacity: f32,
  /** sigmoid(opacity logit) */
  opacityRaw: f32,
  /** dilation compensation √(det Σ2D / det(Σ2D + sI)) */
  rho: f32,
  t: vec3f,
  cov2: vec3f,
  sigma: mat3x3f,
  M: mat3x3f,
  R: mat3x3f,
  s: vec3f,
  qn: vec4f,
  qlen: f32,
  Tm: mat3x2f,
  W: mat3x3f,
  txz: f32,
  tyz: f32,
  clampX: bool,
  clampY: bool,
}

fn projectInternals(gs: Gaussian) -> ProjInternals {
  var p: ProjInternals;
  p.visible = false;
  let W = mat3x3f(camera.view[0].xyz, camera.view[1].xyz, camera.view[2].xyz);
  p.W = W;
  let t = (camera.view * vec4f(gs.mean, 1.0)).xyz;
  p.t = t;
  let z = -t.z;
  p.depth = z;
  p.s = exp(gs.logScale) * camera.scaleMul;
  p.qlen = max(1e-12, length(gs.quat));
  p.qn = gs.quat / p.qlen;
  p.R = quatToRot(p.qn);
  p.M = mat3x3f(p.R[0] * p.s.x, p.R[1] * p.s.y, p.R[2] * p.s.z);
  p.sigma = p.M * transpose(p.M);
  p.color = exp(gs.colorLogit);
  p.opacityRaw = sigmoid(gs.opacityLogit);
  p.opacity = p.opacityRaw;
  p.rho = 1.0;
  if (z < NEAR_Z || p.opacity < ALPHA_MIN) { return p; }

  let limX = FRUSTUM_SLACK * 0.5 * f32(camera.width) / camera.fx;
  let limY = FRUSTUM_SLACK * 0.5 * f32(camera.height) / camera.fy;
  let rawX = t.x / z;
  let rawY = t.y / z;
  p.txz = clamp(rawX, -limX, limX);
  p.tyz = clamp(rawY, -limY, limY);
  p.clampX = rawX != p.txz;
  p.clampY = rawY != p.tyz;
  let J = mat3x2f(
    vec2f(camera.fx / z, 0.0),
    vec2f(0.0, -camera.fy / z),
    vec2f(camera.fx * p.txz / z, -camera.fy * p.tyz / z),
  );
  p.Tm = J * W;
  let cov = p.Tm * p.sigma * transpose(p.Tm);
  let a = cov[0][0] + COV2D_DILATION;
  let b = cov[0][1];
  let c = cov[1][1] + COV2D_DILATION;
  p.cov2 = vec3f(a, b, c);
  let det = a * c - b * b;
  if (!(det > 0.0)) { return p; }
  p.conic = vec3f(c / det, -b / det, a / det);
  // Mip-Splatting 2D filter: the dilation is an anti-aliasing blur, so scale
  // opacity to conserve energy (sub-pixel splats fade, not speckle).
  let det0 = max(1e-20, (a - COV2D_DILATION) * (c - COV2D_DILATION) - b * b);
  p.rho = select(1.0, sqrt(det0 / det), camera.mipFilter != 0u);
  p.opacity = p.opacityRaw * p.rho;
  if (p.opacity < ALPHA_MIN) { return p; }
  let mid = 0.5 * (a + c);
  let lambda = mid + sqrt(max(0.1, mid * mid - det));
  let extent = sqrt(2.0 * log(p.opacity / ALPHA_MIN));
  p.radius = ceil(extent * sqrt(lambda));
  // Exact bounding box of the ellipse — tighter than the circle for
  // elongated splats, so fewer tile intersections.
  p.extentXY = ceil(extent * sqrt(vec2f(a, c)));
  p.uv = vec2f(camera.fx * rawX + camera.cx, camera.cy - camera.fy * rawY);
  // Screen-space cull: the footprint must overlap the image.
  let w = f32(camera.width);
  let h = f32(camera.height);
  let e = p.extentXY;
  if (p.uv.x + e.x < 0.0 || p.uv.x - e.x > w ||
      p.uv.y + e.y < 0.0 || p.uv.y - e.y > h) {
    return p;
  }
  p.visible = p.radius > 0.0;
  return p;
}

/** Inclusive tile rect [min, max) for a projected footprint. */
fn tileRect(uv: vec2f, extent: vec2f) -> vec4u {
  let tx = f32(camera.tilesX);
  let ty = f32(camera.tilesY);
  let lo = clamp(floor((uv - extent) / f32(TILE)), vec2f(0.0), vec2f(tx, ty));
  let hi = clamp(ceil((uv + extent) / f32(TILE)), vec2f(0.0), vec2f(tx, ty));
  return vec4u(u32(lo.x), u32(lo.y), u32(hi.x), u32(hi.y));
}
`;

/** Bindings: 0 camera, 1 params, 2 projected, 3 depthKeys, 4 depthIdx */
export const PROJECT_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> params: array<f32>;
@group(0) @binding(2) var<storage, read_write> projected: array<f32>;
@group(0) @binding(3) var<storage, read_write> depthKeys: array<u32>;
@group(0) @binding(4) var<storage, read_write> depthIdx: array<u32>;

${RASTER_COMMON_WGSL}

@compute @workgroup_size(256)
fn project(
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(num_workgroups) nwg: vec3u,
) {
  let g = linearWorkgroup(wid, nwg) * 256u + lid;
  if (g >= camera.count) { return; }
  let p = projectInternals(loadGaussian(g));
  let o = g * PROJ_STRIDE;
  projected[o] = p.uv.x;
  projected[o + 1u] = p.uv.y;
  projected[o + 2u] = p.conic.x;
  projected[o + 3u] = p.conic.y;
  projected[o + 4u] = p.conic.z;
  projected[o + 5u] = p.depth;
  projected[o + 6u] = p.color.x;
  projected[o + 7u] = p.color.y;
  projected[o + 8u] = p.color.z;
  projected[o + 9u] = p.opacity;
  // [10], [11] = bounding-box half-extents; 0 marks a culled Gaussian.
  projected[o + 10u] = select(0.0, p.extentXY.x, p.visible);
  projected[o + 11u] = select(0.0, p.extentXY.y, p.visible);
  // Positive floats sort correctly as u32; culled Gaussians go last.
  depthKeys[g] = select(0xffffffffu, bitcast<u32>(p.depth), p.visible);
  depthIdx[g] = g;
}
`;

/**
 * Bindings: 0 camera, 1 projected, 2 depthIdx (sorted), 3 counts/offsets (N+1),
 * 4 isectKeys, 5 isectVals
 */
export const TILES_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> projected: array<f32>;
@group(0) @binding(2) var<storage, read> depthIdx: array<u32>;
@group(0) @binding(3) var<storage, read_write> offsets: array<u32>;
@group(0) @binding(4) var<storage, read_write> isectKeys: array<u32>;
@group(0) @binding(5) var<storage, read_write> isectVals: array<u32>;

// unused by these kernels but referenced by the shared projection code
var<private> params: array<f32, 1>;

${RASTER_COMMON_WGSL}

@compute @workgroup_size(256)
fn countTiles(
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(num_workgroups) nwg: vec3u,
) {
  let k = linearWorkgroup(wid, nwg) * 256u + lid;
  if (k > camera.count) { return; }
  if (k == camera.count) { offsets[k] = 0u; return; }
  let g = depthIdx[k];
  let o = g * PROJ_STRIDE;
  let ext = vec2f(projected[o + 10u], projected[o + 11u]);
  if (ext.x <= 0.0) { offsets[k] = 0u; return; }
  let r = tileRect(vec2f(projected[o], projected[o + 1u]), ext);
  offsets[k] = (r.z - r.x) * (r.w - r.y);
}

@compute @workgroup_size(256)
fn emitIntersections(
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(num_workgroups) nwg: vec3u,
) {
  let k = linearWorkgroup(wid, nwg) * 256u + lid;
  if (k >= camera.count) { return; }
  let g = depthIdx[k];
  let o = g * PROJ_STRIDE;
  let ext = vec2f(projected[o + 10u], projected[o + 11u]);
  if (ext.x <= 0.0) { return; }
  let r = tileRect(vec2f(projected[o], projected[o + 1u]), ext);
  var idx = offsets[k];
  for (var ty = r.y; ty < r.w; ty++) {
    for (var tx = r.x; tx < r.z; tx++) {
      if (idx < camera.isectCapacity) {
        isectKeys[idx] = ty * camera.tilesX + tx;
        isectVals[idx] = g;
      }
      idx++;
    }
  }
}
`;

/** Bindings: 0 camera, 1 offsets (total at [count]), 2 isectKeys, 3 tileRanges, 4 indirect */
export const RANGES_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> offsets: array<u32>;
@group(0) @binding(2) var<storage, read> isectKeys: array<u32>;
@group(0) @binding(3) var<storage, read_write> tileRanges: array<u32>;
@group(0) @binding(4) var<storage, read_write> indirect: array<u32>;

${WGSL_LINEAR_WORKGROUP}

struct Camera {
  view: mat4x4f,
  fx: f32, fy: f32, cx: f32, cy: f32,
  width: u32, height: u32, tilesX: u32, tilesY: u32,
  count: u32, isectCapacity: u32, scaleMul: f32, mipFilter: u32,
}

@compute @workgroup_size(1)
fn rangesSetup() {
  let m = min(offsets[camera.count], camera.isectCapacity);
  let blocks = (m + 255u) / 256u;
  indirect[0] = min(blocks, 65535u);
  indirect[1] = select(1u, (blocks + 65534u) / 65535u, blocks > 65535u);
  indirect[2] = 1u;
}

@compute @workgroup_size(256)
fn tileRangesKernel(
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(num_workgroups) nwg: vec3u,
) {
  let m = min(offsets[camera.count], camera.isectCapacity);
  let i = linearWorkgroup(wid, nwg) * 256u + lid;
  if (i >= m) { return; }
  let tile = isectKeys[i];
  if (i == 0u || isectKeys[i - 1u] != tile) { tileRanges[tile * 2u] = i; }
  if (i == m - 1u || isectKeys[i + 1u] != tile) { tileRanges[tile * 2u + 1u] = i + 1u; }
}
`;

/**
 * Bindings: 0 camera, 1 projected, 2 isectVals, 3 tileRanges, 4 image (vec4 per
 * pixel, premultiplied), 5 aux (finalT, lastIndex) per pixel.
 */
export const RASTERIZE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> projected: array<f32>;
@group(0) @binding(2) var<storage, read> isectVals: array<u32>;
@group(0) @binding(3) var<storage, read> tileRanges: array<u32>;
@group(0) @binding(4) var<storage, read_write> image: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> aux: array<vec2f>;

var<private> params: array<f32, 1>;

${RASTER_COMMON_WGSL}

var<workgroup> shUv: array<vec2f, 256>;
var<workgroup> shConicO: array<vec4f, 256>;
var<workgroup> shColor: array<vec3f, 256>;
var<workgroup> shRange: vec2u;
var<workgroup> doneCount: atomic<u32>;
var<workgroup> doneFlag: u32;

@compute @workgroup_size(${TILE}, ${TILE})
fn rasterize(
  @builtin(local_invocation_id) lid3: vec3u,
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
) {
  let tileId = wid.y * camera.tilesX + wid.x;
  let px = wid.xy * TILE + lid3.xy;
  let inside = px.x < camera.width && px.y < camera.height;
  let pixf = vec2f(px) + vec2f(0.5);
  if (lid == 0u) {
    shRange = vec2u(tileRanges[tileId * 2u], tileRanges[tileId * 2u + 1u]);
    atomicStore(&doneCount, 0u);
  }
  workgroupBarrier();
  let range = workgroupUniformLoad(&shRange);

  var T = 1.0;
  var C = vec3f(0.0);
  var last = range.x;
  var done = !inside;
  if (done) { atomicAdd(&doneCount, 1u); }

  for (var batch = range.x; batch < range.y; batch += 256u) {
    workgroupBarrier();
    if (lid == 0u) { doneFlag = atomicLoad(&doneCount); }
    let i = batch + lid;
    if (i < range.y) {
      let g = isectVals[i];
      let o = g * PROJ_STRIDE;
      shUv[lid] = vec2f(projected[o], projected[o + 1u]);
      shConicO[lid] = vec4f(projected[o + 2u], projected[o + 3u], projected[o + 4u], projected[o + 9u]);
      shColor[lid] = vec3f(projected[o + 6u], projected[o + 7u], projected[o + 8u]);
    }
    let nDone = workgroupUniformLoad(&doneFlag);
    if (nDone >= 256u) { break; }
    let n = min(256u, range.y - batch);
    if (!done) {
      for (var j = 0u; j < n; j++) {
        let d = shUv[j] - pixf;
        let co = shConicO[j];
        let power = -0.5 * (co.x * d.x * d.x + co.z * d.y * d.y) - co.y * d.x * d.y;
        if (power > 0.0) { continue; }
        let alpha = min(ALPHA_MAX, co.w * exp(power));
        if (alpha < ALPHA_MIN) { continue; }
        let nextT = T * (1.0 - alpha);
        if (nextT < T_MIN) { done = true; break; }
        C += shColor[j] * (alpha * T);
        T = nextT;
        last = batch + j + 1u;
      }
      if (done) { atomicAdd(&doneCount, 1u); }
    }
  }
  if (inside) {
    let pix = px.y * camera.width + px.x;
    image[pix] = vec4f(C, 1.0 - T);
    aux[pix] = vec2f(T, bitcast<f32>(last));
  }
}
`;

/**
 * Max-blend forward (for MIP-mode volumes): each output channel is the
 * largest single-Gaussian contribution, colour·alpha for rgb and alpha for
 * a, instead of front-to-back compositing. Order doesn't matter, so there
 * is no early termination. `aux` records the winning Gaussian per channel
 * for the backward pass (NO_WINNER when nothing covers the pixel).
 */
export const NO_WINNER = 0xffffffff;

export const RASTERIZE_MAX_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> projected: array<f32>;
@group(0) @binding(2) var<storage, read> isectVals: array<u32>;
@group(0) @binding(3) var<storage, read> tileRanges: array<u32>;
@group(0) @binding(4) var<storage, read_write> image: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> aux: array<vec4u>;

var<private> params: array<f32, 1>;

${RASTER_COMMON_WGSL}

const NO_WINNER: u32 = ${NO_WINNER}u;

var<workgroup> shUv: array<vec2f, 256>;
var<workgroup> shConicO: array<vec4f, 256>;
var<workgroup> shColor: array<vec3f, 256>;
var<workgroup> shIdx: array<u32, 256>;
var<workgroup> shRange: vec2u;

@compute @workgroup_size(${TILE}, ${TILE})
fn rasterizeMax(
  @builtin(local_invocation_id) lid3: vec3u,
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
) {
  let tileId = wid.y * camera.tilesX + wid.x;
  let px = wid.xy * TILE + lid3.xy;
  let inside = px.x < camera.width && px.y < camera.height;
  let pixf = vec2f(px) + vec2f(0.5);
  if (lid == 0u) {
    shRange = vec2u(tileRanges[tileId * 2u], tileRanges[tileId * 2u + 1u]);
  }
  let range = workgroupUniformLoad(&shRange);

  var best = vec4f(0.0);
  var arg = vec4u(NO_WINNER);
  for (var batch = range.x; batch < range.y; batch += 256u) {
    workgroupBarrier();
    let i = batch + lid;
    if (i < range.y) {
      let g = isectVals[i];
      let o = g * PROJ_STRIDE;
      shIdx[lid] = g;
      shUv[lid] = vec2f(projected[o], projected[o + 1u]);
      shConicO[lid] = vec4f(projected[o + 2u], projected[o + 3u], projected[o + 4u], projected[o + 9u]);
      shColor[lid] = vec3f(projected[o + 6u], projected[o + 7u], projected[o + 8u]);
    }
    workgroupBarrier();
    let n = min(256u, range.y - batch);
    if (inside) {
      for (var j = 0u; j < n; j++) {
        let d = shUv[j] - pixf;
        let co = shConicO[j];
        let power = -0.5 * (co.x * d.x * d.x + co.z * d.y * d.y) - co.y * d.x * d.y;
        if (power > 0.0) { continue; }
        let alpha = min(ALPHA_MAX, co.w * exp(power));
        if (alpha < ALPHA_MIN) { continue; }
        let v = vec4f(shColor[j] * alpha, alpha);
        let g = shIdx[j];
        if (v.x > best.x) { best.x = v.x; arg.x = g; }
        if (v.y > best.y) { best.y = v.y; arg.y = g; }
        if (v.z > best.z) { best.z = v.z; arg.z = g; }
        if (v.w > best.w) { best.w = v.w; arg.w = g; }
      }
    }
  }
  if (inside) {
    let pix = px.y * camera.width + px.x;
    image[pix] = best;
    aux[pix] = arg;
  }
}
`;
