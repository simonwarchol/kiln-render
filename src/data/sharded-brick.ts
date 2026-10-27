/** Sharded-format brick bytes → atlas texels (shared by the provider and its gzip workers). */

import { uint16ToFloat16 } from "../utils/float16.js";

/** none: as stored; u16-to-f16: r16float atlas; u16-to-u8: high byte (8-bit atlas). */
export type BrickConversion = "none" | "u16-to-f16" | "u16-to-u8";

export function convertBrick(
  bytes: Uint8Array,
  conversion: BrickConversion,
): Uint8Array | Uint16Array {
  if (conversion === "none") return bytes;
  const u16 =
    bytes.byteOffset % 2 === 0
      ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
      : new Uint16Array(bytes.slice().buffer, 0, bytes.byteLength >> 1);
  if (conversion === "u16-to-f16") return uint16ToFloat16(u16);
  const out = new Uint8Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = u16[i]! >> 8;
  return out;
}
