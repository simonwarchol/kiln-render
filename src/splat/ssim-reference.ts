/**
 * CPU reference for the GPU D-SSIM loss (src/splat/gpu/ssim.ts): same window,
 * constants, zero padding and 4-channel averaging. Used by tests.
 */

const RADIUS = 5;
const SIGMA = 1.5;
const C1 = 0.0001;
const C2 = 0.0009;

function weights(): number[] {
  const w: number[] = [];
  let sum = 0;
  for (let i = -RADIUS; i <= RADIUS; i++) {
    const v = Math.exp(-(i * i) / (2 * SIGMA * SIGMA));
    w.push(v);
    sum += v;
  }
  return w.map((v) => v / sum);
}

function blur(
  src: Float64Array,
  w: number,
  h: number,
  ch: number,
): Float64Array {
  const wt = weights();
  const tmp = new Float64Array(src.length);
  const out = new Float64Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < ch; c++) {
        let s = 0;
        for (let k = -RADIUS; k <= RADIUS; k++) {
          const sx = x + k;
          if (sx < 0 || sx >= w) continue;
          s += wt[k + RADIUS]! * src[(y * w + sx) * ch + c]!;
        }
        tmp[(y * w + x) * ch + c] = s;
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < ch; c++) {
        let s = 0;
        for (let k = -RADIUS; k <= RADIUS; k++) {
          const sy = y + k;
          if (sy < 0 || sy >= h) continue;
          s += wt[k + RADIUS]! * tmp[(sy * w + x) * ch + c]!;
        }
        out[(y * w + x) * ch + c] = s;
      }
  return out;
}

/** Mean SSIM over pixels and 4 channels, and dL/dx for L = λ(1 − mean SSIM). */
export function ssimReference(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  w: number,
  h: number,
  lambda = 1,
): { ssim: number; grad: Float64Array } {
  const n = w * h * 4;
  const X = Float64Array.from(x);
  const Y = Float64Array.from(y);
  const XX = X.map((v) => v * v);
  const YY = Y.map((v) => v * v);
  const XY = X.map((v, i) => v * Y[i]!);
  const mx = blur(X, w, h, 4);
  const my = blur(Y, w, h, 4);
  const px = blur(XX, w, h, 4);
  const py = blur(YY, w, h, 4);
  const pxy = blur(XY, w, h, 4);
  const dm = new Float64Array(n);
  const dpx = new Float64Array(n);
  const dpxy = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a1 = 2 * mx[i]! * my[i]! + C1;
    const a2 = 2 * (pxy[i]! - mx[i]! * my[i]!) + C2;
    const b1 = mx[i]! ** 2 + my[i]! ** 2 + C1;
    const b2 = px[i]! - mx[i]! ** 2 + (py[i]! - my[i]! ** 2) + C2;
    const S = (a1 * a2) / (b1 * b2);
    sum += S;
    dm[i] =
      (2 * my[i]! * a2 - 2 * my[i]! * a1) / (b1 * b2) -
      S * ((2 * mx[i]!) / b1 - (2 * mx[i]!) / b2);
    dpx[i] = -S / b2;
    dpxy[i] = (2 * a1) / (b1 * b2);
  }
  const ga = blur(dm, w, h, 4);
  const gb = blur(dpx, w, h, 4);
  const gc = blur(dpxy, w, h, 4);
  const grad = new Float64Array(n);
  const scale = -lambda / n;
  for (let i = 0; i < n; i++) {
    grad[i] = scale * (ga[i]! + 2 * X[i]! * gb[i]! + Y[i]! * gc[i]!);
  }
  return { ssim: sum / n, grad };
}
