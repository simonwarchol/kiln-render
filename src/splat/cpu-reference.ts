/**
 * CPU reference for the Gaussian splat rasterizer: forward + analytic
 * backward. Slow and simple on purpose — it documents the exact math the WGSL
 * kernels implement and lets tests check gradients by finite differences and
 * check GPU output against it.
 *
 * Conventions (shared with the GPU path):
 * - Parameters per Gaussian (PARAM_STRIDE floats): mean xyz, log-scale xyz,
 *   quaternion wxyz (unnormalised), log colour rgb, opacity logit.
 *   Colour is exp(param): unbounded above, because Kiln's additive
 *   multichannel DVR emits colours > 1 where channels overlap.
 * - View matrix is column-major (wgpu-matrix lookAt): camera looks down -z.
 * - Pixel (x, y) has centre (x + 0.5, y + 0.5); y grows downwards.
 *   u = fx·tx/z + cx, v = cy − fy·ty/z with z = −t.z.
 * - Rendered output is premultiplied colour C = Σ cᵢαᵢTᵢ and alpha A = 1 − T.
 */

export const PARAM_STRIDE = 16;
export const P_MEAN = 0;
export const P_SCALE = 3;
export const P_QUAT = 6;
export const P_COLOR = 10;
export const P_OPACITY = 13;

export const ALPHA_MIN = 1 / 255;
export const ALPHA_MAX = 0.99;
export const T_MIN = 1e-4;
export const COV2D_DILATION = 0.3;
export const NEAR_Z = 0.01;
export const FRUSTUM_SLACK = 1.3;

export interface CameraIntrinsics {
  /** Column-major 4×4 view matrix */
  view: ArrayLike<number>;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Inverse of the colour mapping (colour = exp(param)). */
export function colorParam(c: number): number {
  return Math.log(Math.max(1e-4, c));
}

export function logit(p: number): number {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(c / (1 - c));
}

/** Intrinsics for Kiln's camera (vertical FOV, square pixels). */
export function intrinsicsFor(
  view: ArrayLike<number>,
  width: number,
  height: number,
  fovY: number = Math.PI / 4,
): CameraIntrinsics {
  const f = (0.5 * height) / Math.tan(fovY / 2);
  return { view, fx: f, fy: f, cx: width / 2, cy: height / 2, width, height };
}

type Mat3 = number[]; // row-major 3×3

function quatToRot(w: number, x: number, y: number, z: number): Mat3 {
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}

export interface Projected {
  visible: boolean;
  u: number;
  v: number;
  /** conic = inverse 2D covariance (A, B, C) */
  conic: [number, number, number];
  depth: number;
  color: [number, number, number];
  /** effective opacity o·ρ used for compositing */
  opacity: number;
  radius: number;
  // cached for backward
  /** sigmoid(opacity logit) */
  opacityRaw: number;
  /** dilation compensation √(det Σ2D / det(Σ2D + sI)) */
  rho: number;
  t: [number, number, number];
  cov2: [number, number, number];
  sigma: Mat3;
  M: Mat3;
  R: Mat3;
  s: [number, number, number];
  qn: [number, number, number, number];
  qlen: number;
  Tm: number[]; // 2×3 row-major (J·W)
  W: Mat3;
  txz: number;
  tyz: number;
  clampX: boolean;
  clampY: boolean;
}

export function projectGaussian(
  p: ArrayLike<number>,
  base: number,
  cam: CameraIntrinsics,
): Projected {
  const V = cam.view;
  const mx = p[base + P_MEAN]!;
  const my = p[base + P_MEAN + 1]!;
  const mz = p[base + P_MEAN + 2]!;
  const W: Mat3 = [
    V[0]!,
    V[4]!,
    V[8]!,
    V[1]!,
    V[5]!,
    V[9]!,
    V[2]!,
    V[6]!,
    V[10]!,
  ];
  const t: [number, number, number] = [
    W[0]! * mx + W[1]! * my + W[2]! * mz + V[12]!,
    W[3]! * mx + W[4]! * my + W[5]! * mz + V[13]!,
    W[6]! * mx + W[7]! * my + W[8]! * mz + V[14]!,
  ];
  const z = -t[2];
  const s: [number, number, number] = [
    Math.exp(p[base + P_SCALE]!),
    Math.exp(p[base + P_SCALE + 1]!),
    Math.exp(p[base + P_SCALE + 2]!),
  ];
  const qw = p[base + P_QUAT]!;
  const qx = p[base + P_QUAT + 1]!;
  const qy = p[base + P_QUAT + 2]!;
  const qz = p[base + P_QUAT + 3]!;
  const qlen = Math.max(1e-12, Math.hypot(qw, qx, qy, qz));
  const qn: [number, number, number, number] = [
    qw / qlen,
    qx / qlen,
    qy / qlen,
    qz / qlen,
  ];
  const R = quatToRot(qn[0], qn[1], qn[2], qn[3]);
  const M: Mat3 = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) M[i * 3 + j] = R[i * 3 + j]! * s[j]!;
  const sigma: Mat3 = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let acc = 0;
      for (let k = 0; k < 3; k++) acc += M[i * 3 + k]! * M[j * 3 + k]!;
      sigma[i * 3 + j] = acc;
    }
  const color: [number, number, number] = [
    Math.exp(p[base + P_COLOR]!),
    Math.exp(p[base + P_COLOR + 1]!),
    Math.exp(p[base + P_COLOR + 2]!),
  ];
  const opacity = sigmoid(p[base + P_OPACITY]!);
  const empty: Projected = {
    visible: false,
    u: 0,
    v: 0,
    conic: [0, 0, 0],
    depth: z,
    color,
    opacity,
    radius: 0,
    opacityRaw: opacity,
    rho: 1,
    t,
    cov2: [0, 0, 0],
    sigma,
    M,
    R,
    s,
    qn,
    qlen,
    Tm: [0, 0, 0, 0, 0, 0],
    W,
    txz: 0,
    tyz: 0,
    clampX: false,
    clampY: false,
  };
  if (z < NEAR_Z) return empty;

  const limX = (FRUSTUM_SLACK * (0.5 * cam.width)) / cam.fx;
  const limY = (FRUSTUM_SLACK * (0.5 * cam.height)) / cam.fy;
  const rawX = t[0] / z;
  const rawY = t[1] / z;
  const txz = Math.min(limX, Math.max(-limX, rawX));
  const tyz = Math.min(limY, Math.max(-limY, rawY));
  const J = [
    cam.fx / z,
    0,
    (cam.fx * txz) / z,
    0,
    -cam.fy / z,
    (-cam.fy * tyz) / z,
  ];
  const Tm: number[] = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = 0; k < 3; k++) acc += J[r * 3 + k]! * W[k * 3 + c]!;
      Tm[r * 3 + c] = acc;
    }
  const TS: number[] = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = 0; k < 3; k++) acc += Tm[r * 3 + k]! * sigma[k * 3 + c]!;
      TS[r * 3 + c] = acc;
    }
  const cov = (r: number, c: number) => {
    let acc = 0;
    for (let k = 0; k < 3; k++) acc += TS[r * 3 + k]! * Tm[c * 3 + k]!;
    return acc;
  };
  const a = cov(0, 0) + COV2D_DILATION;
  const b = cov(0, 1);
  const c = cov(1, 1) + COV2D_DILATION;
  const det = a * c - b * b;
  if (!(det > 0)) return empty;
  const conic: [number, number, number] = [c / det, -b / det, a / det];
  // Mip-Splatting's 2D filter: the dilation is an anti-aliasing blur, so
  // scale opacity to conserve the splat's energy (sub-pixel splats fade
  // instead of growing into bright speckle).
  const det0 = Math.max(
    1e-20,
    (a - COV2D_DILATION) * (c - COV2D_DILATION) - b * b,
  );
  const rho = Math.sqrt(det0 / det);
  const effOpacity = opacity * rho;
  const mid = 0.5 * (a + c);
  const lambda = mid + Math.sqrt(Math.max(0.1, mid * mid - det));
  if (effOpacity < ALPHA_MIN) return empty;
  // Beyond this radius α < ALPHA_MIN in every direction (λ is the major axis).
  const extent = Math.sqrt(2 * Math.log(effOpacity / ALPHA_MIN));
  const radius = Math.ceil(extent * Math.sqrt(lambda));
  const u = cam.fx * (t[0] / z) + cam.cx;
  const v = cam.cy - cam.fy * (t[1] / z);
  return {
    ...empty,
    visible: radius > 0,
    u,
    v,
    conic,
    radius,
    opacity: effOpacity,
    rho,
    cov2: [a, b, c],
    Tm,
    txz,
    tyz,
    clampX: rawX !== txz,
    clampY: rawY !== tyz,
  };
}

export interface RenderResult {
  width: number;
  height: number;
  /** premultiplied rgb + alpha, 4 floats per pixel */
  image: Float64Array;
  /** final transmittance per pixel */
  finalT: Float64Array;
  /** per-pixel ordered list of contributing Gaussian indices */
  contributors: number[][];
  /** Max blend only: winning Gaussian per pixel for r, g, b, a (−1 = none). */
  winners?: Int32Array;
  projected: Projected[];
  order: number[];
}

/** Per-pixel combination (see SplatBlend in gpu/rasterizer.ts). */
export type Blend = "alpha" | "max";

/** Pixel-exact forward rasterisation (front-to-back by view depth). */
export function renderReference(
  params: ArrayLike<number>,
  count: number,
  cam: CameraIntrinsics,
  blend: Blend = "alpha",
): RenderResult {
  const projected: Projected[] = [];
  for (let g = 0; g < count; g++)
    projected.push(projectGaussian(params, g * PARAM_STRIDE, cam));
  const order = projected
    .map((_, i) => i)
    .filter((i) => projected[i]!.visible)
    .sort((a, b) => projected[a]!.depth - projected[b]!.depth || a - b);
  return blend === "max"
    ? rasterizeProjectedMax(projected, order, cam.width, cam.height)
    : rasterizeProjected(projected, order, cam.width, cam.height);
}

/**
 * Max blend: each channel takes the largest single contribution, colour·α
 * for rgb and α for a. Ties keep the nearer Gaussian (first in `order`).
 */
export function rasterizeProjectedMax(
  projected: Projected[],
  order: number[],
  width: number,
  height: number,
): RenderResult {
  const image = new Float64Array(width * height * 4);
  const finalT = new Float64Array(width * height).fill(1);
  const winners = new Int32Array(width * height * 4).fill(-1);
  const contributors: number[][] = [];
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const pix = py * width + px;
      for (const g of order) {
        const pr = projected[g]!;
        if (
          Math.abs(pr.u - (px + 0.5)) > pr.radius + 0.5 ||
          Math.abs(pr.v - (py + 0.5)) > pr.radius + 0.5
        )
          continue;
        const dx = pr.u - (px + 0.5);
        const dy = pr.v - (py + 0.5);
        const power =
          -0.5 * (pr.conic[0] * dx * dx + pr.conic[2] * dy * dy) -
          pr.conic[1] * dx * dy;
        if (power > 0) continue;
        const alpha = Math.min(ALPHA_MAX, pr.opacity * Math.exp(power));
        if (alpha < ALPHA_MIN) continue;
        const v = [
          pr.color[0] * alpha,
          pr.color[1] * alpha,
          pr.color[2] * alpha,
          alpha,
        ];
        for (let k = 0; k < 4; k++) {
          if (v[k]! > image[pix * 4 + k]!) {
            image[pix * 4 + k] = v[k]!;
            winners[pix * 4 + k] = g;
          }
        }
      }
      contributors.push([]);
    }
  }
  return {
    width,
    height,
    image,
    finalT,
    contributors,
    projected,
    order,
    winners,
  };
}

/** Backward for {@link rasterizeProjectedMax}: gradients reach winners only. */
export function rasterBackwardMax(
  res: RenderResult,
  dImage: ArrayLike<number>,
  count: number,
): Grad2D[] {
  const grads: Grad2D[] = [];
  for (let g = 0; g < count; g++)
    grads.push({
      u: 0,
      v: 0,
      conicA: 0,
      conicB: 0,
      conicC: 0,
      color: [0, 0, 0],
      opacity: 0,
    });
  const winners = res.winners;
  if (!winners) return grads;
  const { width } = res;
  for (let pix = 0; pix < res.width * res.height; pix++) {
    const px = pix % width;
    const py = Math.floor(pix / width);
    const done = new Set<number>();
    for (let k = 0; k < 4; k++) {
      const g = winners[pix * 4 + k]!;
      if (g < 0 || done.has(g)) continue;
      done.add(g);
      const pr = res.projected[g]!;
      const gr = grads[g]!;
      const dx = pr.u - (px + 0.5);
      const dy = pr.v - (py + 0.5);
      const power =
        -0.5 * (pr.conic[0] * dx * dx + pr.conic[2] * dy * dy) -
        pr.conic[1] * dx * dy;
      const G = Math.exp(power);
      const rawAlpha = pr.opacity * G;
      const alpha = Math.min(ALPHA_MAX, rawAlpha);
      let dAlpha = winners[pix * 4 + 3] === g ? dImage[pix * 4 + 3]! : 0;
      for (let ch = 0; ch < 3; ch++) {
        if (winners[pix * 4 + ch] !== g) continue;
        const dC = dImage[pix * 4 + ch]!;
        gr.color[ch] = gr.color[ch]! + alpha * dC;
        dAlpha += pr.color[ch]! * dC;
      }
      if (rawAlpha >= ALPHA_MAX) continue;
      gr.opacity += G * dAlpha;
      const dPower = alpha * dAlpha;
      gr.conicA += -0.5 * dx * dx * dPower;
      gr.conicC += -0.5 * dy * dy * dPower;
      gr.conicB += -dx * dy * dPower;
      gr.u += -(pr.conic[0] * dx + pr.conic[1] * dy) * dPower;
      gr.v += -(pr.conic[2] * dy + pr.conic[1] * dx) * dPower;
    }
  }
  return grads;
}

/** Rasterise already-projected Gaussians in the given front-to-back order. */
export function rasterizeProjected(
  projected: Projected[],
  order: number[],
  width: number,
  height: number,
): RenderResult {
  const image = new Float64Array(width * height * 4);
  const finalT = new Float64Array(width * height);
  const contributors: number[][] = [];
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const pix = py * width + px;
      let T = 1;
      let r = 0;
      let gC = 0;
      let bC = 0;
      const list: number[] = [];
      for (const g of order) {
        const pr = projected[g]!;
        if (
          Math.abs(pr.u - (px + 0.5)) > pr.radius + 0.5 ||
          Math.abs(pr.v - (py + 0.5)) > pr.radius + 0.5
        )
          continue;
        const dx = pr.u - (px + 0.5);
        const dy = pr.v - (py + 0.5);
        const power =
          -0.5 * (pr.conic[0] * dx * dx + pr.conic[2] * dy * dy) -
          pr.conic[1] * dx * dy;
        if (power > 0) continue;
        const alpha = Math.min(ALPHA_MAX, pr.opacity * Math.exp(power));
        if (alpha < ALPHA_MIN) continue;
        const nextT = T * (1 - alpha);
        if (nextT < T_MIN) break;
        r += pr.color[0] * alpha * T;
        gC += pr.color[1] * alpha * T;
        bC += pr.color[2] * alpha * T;
        T = nextT;
        list.push(g);
      }
      image[pix * 4] = r;
      image[pix * 4 + 1] = gC;
      image[pix * 4 + 2] = bC;
      image[pix * 4 + 3] = 1 - T;
      finalT[pix] = T;
      contributors.push(list);
    }
  }
  return { width, height, image, finalT, contributors, projected, order };
}

/** Per-Gaussian screen-space gradients accumulated by the backward raster. */
export interface Grad2D {
  u: number;
  v: number;
  conicA: number;
  conicB: number;
  conicC: number;
  color: [number, number, number];
  opacity: number;
}

/**
 * Backward rasterisation: given dL/d(image) (4 floats per pixel), accumulate
 * screen-space gradients for each Gaussian.
 */
export function rasterBackward(
  res: RenderResult,
  dImage: ArrayLike<number>,
  count: number,
): Grad2D[] {
  const grads: Grad2D[] = [];
  for (let g = 0; g < count; g++)
    grads.push({
      u: 0,
      v: 0,
      conicA: 0,
      conicB: 0,
      conicC: 0,
      color: [0, 0, 0],
      opacity: 0,
    });
  const { width } = res;
  for (let pix = 0; pix < res.contributors.length; pix++) {
    const px = pix % width;
    const py = Math.floor(pix / width);
    const list = res.contributors[pix]!;
    const dC = [dImage[pix * 4]!, dImage[pix * 4 + 1]!, dImage[pix * 4 + 2]!];
    const dA = dImage[pix * 4 + 3]!;
    const Tfinal = res.finalT[pix]!;
    let T = Tfinal;
    // colour accumulated behind the current Gaussian (normalised by its T)
    const accum = [0, 0, 0];
    let lastAlpha = 0;
    const lastColor = [0, 0, 0];
    for (let k = list.length - 1; k >= 0; k--) {
      const g = list[k]!;
      const pr = res.projected[g]!;
      const dx = pr.u - (px + 0.5);
      const dy = pr.v - (py + 0.5);
      const power =
        -0.5 * (pr.conic[0] * dx * dx + pr.conic[2] * dy * dy) -
        pr.conic[1] * dx * dy;
      const G = Math.exp(power);
      const rawAlpha = pr.opacity * G;
      const alpha = Math.min(ALPHA_MAX, rawAlpha);
      T = T / (1 - alpha);
      for (let ch = 0; ch < 3; ch++) {
        accum[ch] = lastAlpha * lastColor[ch]! + (1 - lastAlpha) * accum[ch]!;
        lastColor[ch] = pr.color[ch]!;
      }
      let dAlpha = 0;
      const gr = grads[g]!;
      for (let ch = 0; ch < 3; ch++) {
        dAlpha += (pr.color[ch]! - accum[ch]!) * dC[ch]!;
        gr.color[ch] = gr.color[ch]! + alpha * T * dC[ch]!;
      }
      dAlpha *= T;
      // A = 1 − Π(1 − αᵢ)  ⇒  ∂A/∂αᵢ = T_final / (1 − αᵢ)
      dAlpha += (dA * Tfinal) / (1 - alpha);
      lastAlpha = alpha;
      if (rawAlpha >= ALPHA_MAX) continue; // clamped: no grad to G / opacity
      gr.opacity += G * dAlpha;
      const dPower = alpha * dAlpha;
      gr.conicA += -0.5 * dx * dx * dPower;
      gr.conicC += -0.5 * dy * dy * dPower;
      gr.conicB += -dx * dy * dPower;
      gr.u += -(pr.conic[0] * dx + pr.conic[1] * dy) * dPower;
      gr.v += -(pr.conic[2] * dy + pr.conic[1] * dx) * dPower;
    }
  }
  return grads;
}

/** Chain screen-space gradients back to the raw parameters of one Gaussian. */
export function projectBackward(
  pr: Projected,
  g2: Grad2D,
  cam: CameraIntrinsics,
  out: Float32Array | number[],
  base: number,
): void {
  if (!pr.visible) return;
  const [a, b, c] = pr.cov2;
  const det = a * c - b * b;
  const det2 = det * det;
  const gA = g2.conicA;
  const gB = g2.conicB;
  const gC = g2.conicC;
  // conic = (c, −b, a)/det
  // Effective opacity o·ρ(a, b, c): g2.opacity is dL/d(o·ρ).
  const s0 = COV2D_DILATION;
  const det0 = (a - s0) * (c - s0) - b * b;
  const gRho = g2.opacity * pr.opacityRaw * pr.rho; // dL/d ln ρ
  const ok = det0 > 1e-20;
  const dLda =
    (gA * (-c * c) + gB * (b * c) + gC * (-b * b)) / det2 +
    (ok ? gRho * 0.5 * ((c - s0) / det0 - c / det) : 0);
  const dLdb =
    (gA * (2 * b * c) + gB * (-det - 2 * b * b) + gC * (2 * a * b)) / det2 +
    (ok ? gRho * b * (1 / det - 1 / det0) : 0);
  const dLdc =
    (gA * (-b * b) + gB * (a * b) + gC * (-a * a)) / det2 +
    (ok ? gRho * 0.5 * ((a - s0) / det0 - a / det) : 0);
  // dL/dΣ2 as a symmetric matrix (b appears twice)
  const G2 = [dLda, 0.5 * dLdb, 0.5 * dLdb, dLdc];
  const Tm = pr.Tm;
  // dL/dΣ = Tmᵀ G2 Tm
  const dSigma: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let acc = 0;
      for (let r = 0; r < 2; r++)
        for (let q = 0; q < 2; q++)
          acc += Tm[r * 3 + i]! * G2[r * 2 + q]! * Tm[q * 3 + j]!;
      dSigma[i * 3 + j] = acc;
    }
  // Σ = M Mᵀ  ⇒  dL/dM = 2 dΣ M
  const dM: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let acc = 0;
      for (let k = 0; k < 3; k++) acc += dSigma[i * 3 + k]! * pr.M[k * 3 + j]!;
      dM[i * 3 + j] = 2 * acc;
    }
  // M = R S
  for (let j = 0; j < 3; j++) {
    let ds = 0;
    for (let i = 0; i < 3; i++) ds += pr.R[i * 3 + j]! * dM[i * 3 + j]!;
    out[base + P_SCALE + j] = out[base + P_SCALE + j]! + ds * pr.s[j]!;
  }
  const dR: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) dR[i * 3 + j] = dM[i * 3 + j]! * pr.s[j]!;
  const [w, x, y, z] = pr.qn;
  const dqn = [
    2 *
      (-z * dR[1]! +
        y * dR[2]! +
        z * dR[3]! -
        x * dR[5]! -
        y * dR[6]! +
        x * dR[7]!),
    2 *
      (y * dR[1]! +
        z * dR[2]! +
        y * dR[3]! -
        2 * x * dR[4]! -
        w * dR[5]! +
        z * dR[6]! +
        w * dR[7]! -
        2 * x * dR[8]!),
    2 *
      (-2 * y * dR[0]! +
        x * dR[1]! +
        w * dR[2]! +
        x * dR[3]! +
        z * dR[5]! -
        w * dR[6]! +
        z * dR[7]! -
        2 * y * dR[8]!),
    2 *
      (-2 * z * dR[0]! -
        w * dR[1]! +
        x * dR[2]! +
        w * dR[3]! -
        2 * z * dR[4]! +
        y * dR[5]! +
        x * dR[6]! +
        y * dR[7]!),
  ];
  const dot = dqn[0]! * w + dqn[1]! * x + dqn[2]! * y + dqn[3]! * z;
  const qn = pr.qn;
  for (let k = 0; k < 4; k++)
    out[base + P_QUAT + k] =
      out[base + P_QUAT + k]! + (dqn[k]! - qn[k]! * dot) / pr.qlen;

  // Mean: through (u, v) and through J (cov2 depends on t).
  const t = pr.t;
  const zz = -t[2];
  const dt: [number, number, number] = [0, 0, 0];
  dt[0] = dt[0]! + (g2.u * cam.fx) / zz;
  dt[2] += (g2.u * cam.fx * t[0]) / (zz * zz);
  dt[1] += (-g2.v * cam.fy) / zz;
  dt[2] += (-g2.v * cam.fy * t[1]) / (zz * zz);
  // dL/dTm = 2 G2 Tm Σ ; dL/dJ = dL/dTm Wᵀ
  const TmS: number[] = [];
  for (let r = 0; r < 2; r++)
    for (let col = 0; col < 3; col++) {
      let acc = 0;
      for (let k = 0; k < 3; k++)
        acc += Tm[r * 3 + k]! * pr.sigma[k * 3 + col]!;
      TmS[r * 3 + col] = acc;
    }
  const dTm: number[] = [];
  for (let r = 0; r < 2; r++)
    for (let col = 0; col < 3; col++) {
      let acc = 0;
      for (let q = 0; q < 2; q++) acc += G2[r * 2 + q]! * TmS[q * 3 + col]!;
      dTm[r * 3 + col] = 2 * acc;
    }
  const dJ: number[] = [];
  for (let r = 0; r < 2; r++)
    for (let k = 0; k < 3; k++) {
      let acc = 0;
      for (let col = 0; col < 3; col++)
        acc += dTm[r * 3 + col]! * pr.W[k * 3 + col]!;
      dJ[r * 3 + k] = acc;
    }
  const z2 = zz * zz;
  // J00 = fx/z, J02 = fx·txz/z, J11 = −fy/z, J12 = −fy·tyz/z (dz/dt.z = −1)
  dt[2] += (dJ[0]! * cam.fx) / z2;
  dt[2] += (dJ[4]! * -cam.fy) / z2;
  if (pr.clampX) {
    dt[2] += (dJ[2]! * cam.fx * pr.txz) / z2;
  } else {
    dt[0] += (dJ[2]! * cam.fx) / z2;
    dt[2] += (dJ[2]! * 2 * cam.fx * t[0]) / (z2 * zz);
  }
  if (pr.clampY) {
    dt[2] += (dJ[5]! * -cam.fy * pr.tyz) / z2;
  } else {
    dt[1] += (dJ[5]! * -cam.fy) / z2;
    dt[2] += (dJ[5]! * -2 * cam.fy * t[1]) / (z2 * zz);
  }
  const W = pr.W;
  for (let k = 0; k < 3; k++)
    out[base + P_MEAN + k] =
      out[base + P_MEAN + k]! +
      W[0 * 3 + k]! * dt[0]! +
      W[1 * 3 + k]! * dt[1]! +
      W[2 * 3 + k]! * dt[2]!;

  for (let ch = 0; ch < 3; ch++)
    out[base + P_COLOR + ch] =
      out[base + P_COLOR + ch]! + g2.color[ch]! * pr.color[ch]!;
  const o = pr.opacityRaw;
  out[base + P_OPACITY] =
    out[base + P_OPACITY]! + g2.opacity * pr.rho * o * (1 - o);
}

/** Full backward: dL/dparams for every Gaussian. */
export function backwardReference(
  params: ArrayLike<number>,
  count: number,
  cam: CameraIntrinsics,
  dImage: ArrayLike<number>,
  res: RenderResult = renderReference(params, count, cam),
): Float32Array {
  const g2 = res.winners
    ? rasterBackwardMax(res, dImage, count)
    : rasterBackward(res, dImage, count);
  const out = new Float32Array(count * PARAM_STRIDE);
  for (let g = 0; g < count; g++)
    projectBackward(res.projected[g]!, g2[g]!, cam, out, g * PARAM_STRIDE);
  return out;
}
