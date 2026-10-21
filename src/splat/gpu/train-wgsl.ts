/**
 * WGSL for splat training: loss, backward rasterisation, projection
 * backward, and Adam. Mirrors src/splat/cpu-reference.ts.
 */

import { wgslAtomicAddF } from "./kernel.js";
import { NO_WINNER, RASTER_COMMON_WGSL, TILE } from "./raster-wgsl.js";

export const GRAD2D_STRIDE = 10;
export const STATS_STRIDE = 2;

/** Train uniform layout: see TrainParams in LOSS_WGSL. */
export const TRAIN_UNIFORM_SIZE = 64;

export const LOSS_WGSL = /* wgsl */ `
struct TrainParams {
  width: u32,
  height: u32,
  layer: u32,
  _pad0: u32,
  l1Weight: f32,
  _p1: f32,
  alphaWeight: f32,
  invPixels: f32,
  background: vec4f,
}

@group(0) @binding(0) var<uniform> tp: TrainParams;
@group(0) @binding(1) var<storage, read> image: array<vec4f>;
@group(0) @binding(2) var targets: texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read_write> dImage: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> lossAccum: array<atomic<u32>>;

var<workgroup> partial: array<f32, 256>;

${wgslAtomicAddF("atomicAddLoss", "lossAccum")}

@compute @workgroup_size(16, 16)
fn loss(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_index) lid: u32,
) {
  var l = 0.0;
  if (gid.x < tp.width && gid.y < tp.height) {
    let pix = gid.y * tp.width + gid.x;
    let pred = image[pix];
    let want = textureLoad(targets, vec2i(gid.xy), i32(tp.layer), 0);
    let diff = pred - want;
    let w = vec4f(1.0, 1.0, 1.0, tp.alphaWeight);
    let g = tp.l1Weight * sign(diff) * w * tp.invPixels;
    dImage[pix] = g;
    l = dot(abs(diff), w) * tp.l1Weight;
  }
  partial[lid] = l;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (lid < s) { partial[lid] += partial[lid + s]; }
    workgroupBarrier();
  }
  if (lid == 0u) { atomicAddLoss(0u, partial[0] * tp.invPixels); }
}
`;

/**
 * Bindings: 0 camera, 1 projected, 2 isectVals, 3 tileRanges, 4 aux,
 * 5 dImage, 6 grad2D (atomic f32 as u32)
 */
export function rasterBackwardWgsl(
  useSubgroups: boolean,
  maxSubgroups = 32,
): string {
  // Per-gaussian gradients are summed over the tile in two levels before
  // touching global memory: across each subgroup (subgroupAdd), then across
  // the workgroup in shared memory for GROUP gaussians at a time. Global
  // float atomics (CAS loops — WebGPU has no float atomics) are the
  // bottleneck, and this issues one per gaussian·component·tile.
  const sum = (v: string) => (useSubgroups ? `subgroupAdd(${v})` : v);
  // With subgroups each subgroup leader owns a slot (subgroups are contiguous
  // runs of local_invocation_index); without, every thread CAS-adds into one.
  const store = (i: string, v: string) =>
    useSubgroups ? `red[slot + ${i}] = ${v};` : `sharedAddF(${i}, ${v});`;
  return /* wgsl */ `
${useSubgroups ? "enable subgroups;\ndiagnostic(off, subgroup_uniformity);" : ""}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> projected: array<f32>;
@group(0) @binding(2) var<storage, read> isectVals: array<u32>;
@group(0) @binding(3) var<storage, read> tileRanges: array<u32>;
@group(0) @binding(4) var<storage, read> aux: array<vec2f>;
@group(0) @binding(5) var<storage, read> dImage: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> grad2D: array<atomic<u32>>;

var<private> params: array<f32, 1>;

${RASTER_COMMON_WGSL}

const GRAD2D_STRIDE: u32 = ${GRAD2D_STRIDE}u;
const GROUP: u32 = 16u;

${wgslAtomicAddF("atomicAddF", "grad2D")}

${
  useSubgroups
    ? `// [subgroup][gaussian in group][component]
var<workgroup> red: array<f32, ${maxSubgroups * 16 * 9}>;`
    : `var<workgroup> red: array<atomic<u32>, ${16 * 9}>;

${wgslAtomicAddF("sharedAddF", "red")}`
}

var<workgroup> shUv: array<vec2f, 256>;
var<workgroup> shConicO: array<vec4f, 256>;
var<workgroup> shColor: array<vec3f, 256>;
var<workgroup> shIdx: array<u32, 256>;
var<workgroup> shRange: vec2u;
var<workgroup> shLast: atomic<u32>;
var<workgroup> shEnd: u32;

@compute @workgroup_size(${TILE}, ${TILE})
fn rasterBackward(
  @builtin(local_invocation_id) lid3: vec3u,
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
  ${useSubgroups ? "@builtin(subgroup_invocation_id) sgid: u32, @builtin(subgroup_size) sgSize: u32," : ""}
) {
  let tileId = wid.y * camera.tilesX + wid.x;
  let px = wid.xy * TILE + lid3.xy;
  let inside = px.x < camera.width && px.y < camera.height;
  let pixf = vec2f(px) + vec2f(0.5);
  if (lid == 0u) {
    shRange = vec2u(tileRanges[tileId * 2u], tileRanges[tileId * 2u + 1u]);
    atomicStore(&shLast, 0u);
  }
  let range = workgroupUniformLoad(&shRange);
  ${useSubgroups ? "let numSg = (256u + sgSize - 1u) / sgSize;\n  let sg = lid / sgSize;" : ""}

  var Tfinal = 1.0;
  var lastIdx = range.x;
  var dC = vec3f(0.0);
  var dA = 0.0;
  if (inside) {
    let pix = px.y * camera.width + px.x;
    let a = aux[pix];
    Tfinal = a.x;
    lastIdx = bitcast<u32>(a.y);
    let di = dImage[pix];
    dC = di.xyz;
    dA = di.w;
  }
  var T = Tfinal;
  var accum = vec3f(0.0);
  var lastAlpha = 0.0;
  var lastColor = vec3f(0.0);

  // Start past the tile's last contributing Gaussian, not the end of its
  // list: behind that, every pixel had already stopped (T < T_MIN).
  if (inside) { atomicMax(&shLast, lastIdx); }
  workgroupBarrier();
  if (lid == 0u) { shEnd = max(range.x, atomicLoad(&shLast)); }
  let end = workgroupUniformLoad(&shEnd);
  let total = end - range.x;
  let numBatches = (total + 255u) / 256u;
  for (var bi = 0u; bi < numBatches; bi++) {
    let batchEnd = end - bi * 256u;
    let n = min(256u, batchEnd - range.x);
    workgroupBarrier();
    if (lid < n) {
      let i = batchEnd - 1u - lid;
      let g = isectVals[i];
      let o = g * PROJ_STRIDE;
      shIdx[lid] = g;
      shUv[lid] = vec2f(projected[o], projected[o + 1u]);
      shConicO[lid] = vec4f(projected[o + 2u], projected[o + 3u], projected[o + 4u], projected[o + 9u]);
      shColor[lid] = vec3f(projected[o + 6u], projected[o + 7u], projected[o + 8u]);
    }
    workgroupBarrier();
    for (var j0 = 0u; j0 < n; j0 += GROUP) {
      for (var jj = 0u; jj < GROUP; jj++) {
        let j = j0 + jj;
        var gUv = vec2f(0.0);
        var gConic = vec3f(0.0);
        var gColor = vec3f(0.0);
        var gO = 0.0;
        if (j < n && inside && batchEnd - 1u - j < lastIdx) {
          let co = shConicO[j];
          let d = shUv[j] - pixf;
          let power = -0.5 * (co.x * d.x * d.x + co.z * d.y * d.y) - co.y * d.x * d.y;
          if (power <= 0.0) {
            let G = exp(power);
            let rawAlpha = co.w * G;
            let alpha = min(ALPHA_MAX, rawAlpha);
            if (alpha >= ALPHA_MIN) {
              T = T / (1.0 - alpha);
              accum = lastAlpha * lastColor + (1.0 - lastAlpha) * accum;
              let c = shColor[j];
              lastColor = c;
              let dAlpha = dot(c - accum, dC) * T + dA * Tfinal / (1.0 - alpha);
              gColor = alpha * T * dC;
              lastAlpha = alpha;
              if (rawAlpha < ALPHA_MAX) {
                gO = G * dAlpha;
                let dPower = alpha * dAlpha;
                gConic = vec3f(-0.5 * d.x * d.x, -d.x * d.y, -0.5 * d.y * d.y) * dPower;
                gUv = vec2f(-(co.x * d.x + co.y * d.y), -(co.z * d.y + co.y * d.x)) * dPower;
              }
            }
          }
        }
        let sUv = ${sum("gUv")};
        let sConic = ${sum("gConic")};
        let sColor = ${sum("gColor")};
        let sO = ${sum("gO")};
        if (${useSubgroups ? "sgid == 0u" : "true"}) {
          ${useSubgroups ? "let slot = (sg * GROUP + jj) * 9u;" : "let slot = jj * 9u;"}
          ${store("0u", "sUv.x")}
          ${store("1u", "sUv.y")}
          ${store("2u", "sConic.x")}
          ${store("3u", "sConic.y")}
          ${store("4u", "sConic.z")}
          ${store("5u", "sColor.x")}
          ${store("6u", "sColor.y")}
          ${store("7u", "sColor.z")}
          ${store("8u", "sO")}
        }
      }
      workgroupBarrier();
      // Flush: one global atomic per gaussian·component for the whole tile.
      if (lid < GROUP * 9u) {
        ${
          useSubgroups
            ? `var v = 0.0;
        for (var s = 0u; s < numSg; s++) { v += red[s * GROUP * 9u + lid]; }`
            : "let v = bitcast<f32>(atomicExchange(&red[lid], 0u));"
        }
        let j = j0 + lid / 9u;
        if (v != 0.0 && j < n) {
          atomicAddF(shIdx[j] * GRAD2D_STRIDE + lid % 9u, v);
        }
      }
      workgroupBarrier();
    }
  }
}
`;
}

/**
 * Backward for max blend (RASTERIZE_MAX_WGSL): each output channel depends
 * only on its winning Gaussian, out_k = colour_k·α (k < 3) and α (k = 3),
 * α = min(ALPHA_MAX, o·G). One thread per pixel adds that Gaussian's 2D
 * gradients (same layout as rasterBackward: uv, conic, colour, opacity).
 */
export const RASTER_BACKWARD_MAX_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> projected: array<f32>;
@group(0) @binding(2) var<storage, read> aux: array<vec4u>;
@group(0) @binding(3) var<storage, read> dImage: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> grad2D: array<atomic<u32>>;

var<private> params: array<f32, 1>;

${RASTER_COMMON_WGSL}

const GRAD2D_STRIDE: u32 = ${GRAD2D_STRIDE}u;
const NO_WINNER: u32 = ${NO_WINNER}u;

${wgslAtomicAddF("atomicAddF", "grad2D")}

fn addWinner(g: u32, pixf: vec2f, dColor: vec3f, dAlphaOut: f32) {
  let o = g * PROJ_STRIDE;
  let uv = vec2f(projected[o], projected[o + 1u]);
  let co = vec4f(projected[o + 2u], projected[o + 3u], projected[o + 4u], projected[o + 9u]);
  let c = vec3f(projected[o + 6u], projected[o + 7u], projected[o + 8u]);
  let d = uv - pixf;
  let power = -0.5 * (co.x * d.x * d.x + co.z * d.y * d.y) - co.y * d.x * d.y;
  let G = exp(power);
  let rawAlpha = co.w * G;
  let alpha = min(ALPHA_MAX, rawAlpha);
  let base = g * GRAD2D_STRIDE;
  let gColor = alpha * dColor;
  atomicAddF(base + 5u, gColor.x);
  atomicAddF(base + 6u, gColor.y);
  atomicAddF(base + 7u, gColor.z);
  if (rawAlpha >= ALPHA_MAX) { return; }
  let dAlpha = dot(c, dColor) + dAlphaOut;
  let dPower = alpha * dAlpha;
  let gConic = vec3f(-0.5 * d.x * d.x, -d.x * d.y, -0.5 * d.y * d.y) * dPower;
  let gUv = vec2f(-(co.x * d.x + co.y * d.y), -(co.z * d.y + co.y * d.x)) * dPower;
  atomicAddF(base, gUv.x);
  atomicAddF(base + 1u, gUv.y);
  atomicAddF(base + 2u, gConic.x);
  atomicAddF(base + 3u, gConic.y);
  atomicAddF(base + 4u, gConic.z);
  atomicAddF(base + 8u, G * dAlpha);
}

@compute @workgroup_size(${TILE}, ${TILE})
fn rasterBackwardMax(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= camera.width || gid.y >= camera.height) { return; }
  let pix = gid.y * camera.width + gid.x;
  let pixf = vec2f(gid.xy) + vec2f(0.5);
  let arg = aux[pix];
  let di = dImage[pix];
  // Each distinct winner once, with every output it won.
  for (var k = 0u; k < 4u; k++) {
    let g = arg[k];
    if (g == NO_WINNER) { continue; }
    var seen = false;
    for (var m = 0u; m < k; m++) { seen = seen || arg[m] == g; }
    if (seen) { continue; }
    let dColor = vec3f(
      select(0.0, di.x, arg.x == g),
      select(0.0, di.y, arg.y == g),
      select(0.0, di.z, arg.z == g),
    );
    addWinner(g, pixf, dColor, select(0.0, di.w, arg.w == g));
  }
}
`;

/** Adam uniform: group learning rates + scalars. */
export const ADAM_UNIFORM_SIZE = 64;

/**
 * Projection backward (screen-space → parameter gradients), either written
 * out (`projectBackward`, for tests) or fused with sparse Adam
 * (`projectBackwardAdam`, for training — no gradient buffer round trip).
 *
 * Bindings: 0 camera, 1 params, 2 grad2D, 3 stats, 4 adam, 5 m1, 6 m2,
 * 7 paramGrads
 */
export const PROJECT_BACKWARD_WGSL = /* wgsl */ `
struct AdamParams {
  lrMean: f32,
  lrScale: f32,
  lrQuat: f32,
  lrColor: f32,
  lrOpacity: f32,
  beta1: f32,
  beta2: f32,
  eps: f32,
  bias1: f32,
  bias2: f32,
  count: u32,
  maxLogScale: f32,
  minLogScale: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read_write> params: array<f32>;
@group(0) @binding(2) var<storage, read> grad2D: array<f32>;
@group(0) @binding(3) var<storage, read_write> stats: array<f32>;
@group(0) @binding(4) var<uniform> ap: AdamParams;
@group(0) @binding(5) var<storage, read_write> m1: array<f32>;
@group(0) @binding(6) var<storage, read_write> m2: array<f32>;
@group(0) @binding(7) var<storage, read_write> paramGrads: array<f32>;

${RASTER_COMMON_WGSL}

const GRAD2D_STRIDE: u32 = ${GRAD2D_STRIDE}u;
const STATS_STRIDE: u32 = ${STATS_STRIDE}u;

/** dL/dparams[0..14) of a visible Gaussian; also updates densify stats. */
fn paramGradients(g: u32, pr: ProjInternals) -> array<f32, 14> {
  let gb = g * GRAD2D_STRIDE;
  let gUv = vec2f(grad2D[gb], grad2D[gb + 1u]);
  let gA = grad2D[gb + 2u];
  let gB = grad2D[gb + 3u];
  let gC = grad2D[gb + 4u];
  let gColor = vec3f(grad2D[gb + 5u], grad2D[gb + 6u], grad2D[gb + 7u]);
  let gO = grad2D[gb + 8u];

  // Densification statistic: screen-space positional gradient magnitude in
  // NDC units (independent of resolution).
  let sb = g * STATS_STRIDE;
  stats[sb] += length(gUv * vec2f(0.5 * f32(camera.width), 0.5 * f32(camera.height)));
  stats[sb + 1u] += 1.0;

  let a = pr.cov2.x;
  let b = pr.cov2.y;
  let c = pr.cov2.z;
  let det = a * c - b * b;
  let det2 = det * det;
  // Effective opacity o·ρ(a, b, c): gO is dL/d(o·ρ).
  let s0 = COV2D_DILATION;
  let det0Raw = (a - s0) * (c - s0) - b * b;
  let gRho = select(0.0, gO * pr.opacityRaw * pr.rho, det0Raw > 1e-20 && camera.mipFilter != 0u); // dL/d ln ρ
  let det0 = max(det0Raw, 1e-20);
  let dLda = (gA * (-c * c) + gB * (b * c) + gC * (-b * b)) / det2
    + gRho * 0.5 * ((c - s0) / det0 - c / det);
  let dLdb = (gA * (2.0 * b * c) + gB * (-det - 2.0 * b * b) + gC * (2.0 * a * b)) / det2
    + gRho * b * (1.0 / det - 1.0 / det0);
  let dLdc = (gA * (-b * b) + gB * (a * b) + gC * (-a * a)) / det2
    + gRho * 0.5 * ((a - s0) / det0 - a / det);
  let G2 = mat2x2f(vec2f(dLda, 0.5 * dLdb), vec2f(0.5 * dLdb, dLdc));
  let Tm = pr.Tm;
  let dSigma = transpose(Tm) * G2 * Tm;
  let dM = 2.0 * dSigma * pr.M;
  // M = R·S (columns of R scaled by s)
  let s = pr.s;
  let dS = vec3f(dot(pr.R[0], dM[0]), dot(pr.R[1], dM[1]), dot(pr.R[2], dM[2]));
  let dLogScale = dS * s;
  let dRw = mat3x3f(dM[0] * s.x, dM[1] * s.y, dM[2] * s.z);
  // dR_ij (row i, col j) = dRw[j][i]
  let r00 = dRw[0][0]; let r01 = dRw[1][0]; let r02 = dRw[2][0];
  let r10 = dRw[0][1]; let r11 = dRw[1][1]; let r12 = dRw[2][1];
  let r20 = dRw[0][2]; let r21 = dRw[1][2]; let r22 = dRw[2][2];
  let w = pr.qn.x; let x = pr.qn.y; let y = pr.qn.z; let z = pr.qn.w;
  let dqn = 2.0 * vec4f(
    -z * r01 + y * r02 + z * r10 - x * r12 - y * r20 + x * r21,
    y * r01 + z * r02 + y * r10 - 2.0 * x * r11 - w * r12 + z * r20 + w * r21 - 2.0 * x * r22,
    -2.0 * y * r00 + x * r01 + w * r02 + x * r10 + z * r12 - w * r20 + z * r21 - 2.0 * y * r22,
    -2.0 * z * r00 - w * r01 + x * r02 + w * r10 - 2.0 * z * r11 + y * r12 + x * r20 + y * r21,
  );
  let dQuat = (dqn - pr.qn * dot(dqn, pr.qn)) / pr.qlen;

  // Mean: through (u, v) and through the Jacobian.
  let t = pr.t;
  let zz = -t.z;
  let z2 = zz * zz;
  var dt = vec3f(0.0);
  dt.x += gUv.x * camera.fx / zz;
  dt.z += gUv.x * camera.fx * t.x / z2;
  dt.y += -gUv.y * camera.fy / zz;
  dt.z += -gUv.y * camera.fy * t.y / z2;
  let dTm = 2.0 * G2 * Tm * pr.sigma;
  let dJ = dTm * transpose(pr.W);
  // dJ[col][row]: J00 = dJ[0][0], J02 = dJ[2][0], J11 = dJ[1][1], J12 = dJ[2][1]
  dt.z += dJ[0][0] * camera.fx / z2;
  dt.z += dJ[1][1] * -camera.fy / z2;
  if (pr.clampX) {
    dt.z += dJ[2][0] * camera.fx * pr.txz / z2;
  } else {
    dt.x += dJ[2][0] * camera.fx / z2;
    dt.z += dJ[2][0] * 2.0 * camera.fx * t.x / (z2 * zz);
  }
  if (pr.clampY) {
    dt.z += dJ[2][1] * -camera.fy * pr.tyz / z2;
  } else {
    dt.y += dJ[2][1] * -camera.fy / z2;
    dt.z += dJ[2][1] * -2.0 * camera.fy * t.y / (z2 * zz);
  }
  let dMean = transpose(pr.W) * dt;
  let dColor = gColor * pr.color;
  let dOpacity = gO * pr.rho * pr.opacityRaw * (1.0 - pr.opacityRaw);
  return array<f32, 14>(
    dMean.x, dMean.y, dMean.z,
    dLogScale.x, dLogScale.y, dLogScale.z,
    dQuat.x, dQuat.y, dQuat.z, dQuat.w,
    dColor.x, dColor.y, dColor.z,
    dOpacity,
  );
}

@compute @workgroup_size(256)
fn projectBackward(
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(num_workgroups) nwg: vec3u,
) {
  let g = linearWorkgroup(wid, nwg) * 256u + lid;
  if (g >= camera.count) { return; }
  let ob = g * PARAM_STRIDE;
  for (var k = 0u; k < PARAM_STRIDE; k++) { paramGrads[ob + k] = 0.0; }
  let pr = projectInternals(loadGaussian(g));
  if (!pr.visible) { return; }
  let grad = paramGradients(g, pr);
  for (var k = 0u; k < 14u; k++) { paramGrads[ob + k] = grad[k]; }
}

fn lrFor(k: u32) -> f32 {
  if (k < 3u) { return ap.lrMean; }
  if (k < 6u) { return ap.lrScale; }
  if (k < 10u) { return ap.lrQuat; }
  if (k < 13u) { return ap.lrColor; }
  return ap.lrOpacity;
}

/** Sparse Adam: Gaussians not visible this step keep their state. */
@compute @workgroup_size(256)
fn projectBackwardAdam(
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(num_workgroups) nwg: vec3u,
) {
  let g = linearWorkgroup(wid, nwg) * 256u + lid;
  if (g >= camera.count) { return; }
  let pr = projectInternals(loadGaussian(g));
  if (!pr.visible) { return; }
  let grad = paramGradients(g, pr);
  let b = g * PARAM_STRIDE;
  for (var k = 0u; k < 14u; k++) {
    let i = b + k;
    let gr = grad[k];
    let m = ap.beta1 * m1[i] + (1.0 - ap.beta1) * gr;
    let v = ap.beta2 * m2[i] + (1.0 - ap.beta2) * gr * gr;
    m1[i] = m;
    m2[i] = v;
    var p = params[i] - lrFor(k) * (m / ap.bias1) / (sqrt(v / ap.bias2) + ap.eps);
    if (k >= 3u && k < 6u) { p = clamp(p, ap.minLogScale, ap.maxLogScale); }
    params[i] = p;
  }
}
`;
