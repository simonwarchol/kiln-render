/**
 * h5wasm uses Python struct codes (`<B`, `<H`, `<f`), not numpy names.
 * Dataset.metadata is the reliable source when present.
 */

export interface H5NumericMeta {
  type: number;
  size: number;
  signed: boolean;
}

/** HDF5 class IDs (H5T_INTEGER = 0, H5T_FLOAT = 1). */
const H5T_INTEGER = 0;
const H5T_FLOAT = 1;

export function parseImsDtype(
  dtype: unknown,
  meta?: H5NumericMeta,
): { bitDepth: 8 | 16; isFloat: boolean } | null {
  if (meta) {
    if (meta.type === H5T_INTEGER && meta.size === 1) {
      return { bitDepth: 8, isFloat: false };
    }
    if (meta.type === H5T_INTEGER && meta.size === 2) {
      return { bitDepth: 16, isFloat: false };
    }
    if (meta.type === H5T_FLOAT && meta.size === 4) {
      return { bitDepth: 16, isFloat: true };
    }
  }
  return parseDtypeString(dtype);
}

function parseDtypeString(
  dtype: unknown,
): { bitDepth: 8 | 16; isFloat: boolean } | null {
  if (typeof dtype !== "string") return null;
  const s = dtype.toLowerCase();
  // h5wasm struct codes: B/b=i8, H/h=i16, f=f32
  if (/(^|[<>|])b$/.test(s) || s.includes("u1") || s.includes("uint8")) {
    return { bitDepth: 8, isFloat: false };
  }
  if (/(^|[<>|])h$/.test(s) || s.includes("u2") || s.includes("uint16")) {
    return { bitDepth: 16, isFloat: false };
  }
  if (/(^|[<>|])f$/.test(s) || s.includes("f4") || s.includes("float32")) {
    return { bitDepth: 16, isFloat: true };
  }
  return null;
}

export function describeImsDtype(dtype: unknown, meta?: H5NumericMeta): string {
  if (typeof dtype === "string" && dtype) return dtype;
  if (meta) {
    return `type=${meta.type} size=${meta.size} signed=${meta.signed}`;
  }
  try {
    return JSON.stringify(dtype) ?? "unknown";
  } catch {
    return "unknown";
  }
}
