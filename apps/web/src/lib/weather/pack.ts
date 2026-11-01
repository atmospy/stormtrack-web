/**
 * Compact CPU copies of decoded weather frames (what the meteogram, readout and arrow field sample).
 * Vector frames keep the 8-bit R,G bytes (2 B/px); scalar frames keep the 16-bit value (2 B/px), so a
 * 720x361 frame costs ~0.5 MB and a whole forecast of four fields stays well under 100 MB.
 */
export type Packed =
  | { kind: 'vector'; w: number; h: number; data: Uint8Array }
  | { kind: 'scalar'; w: number; h: number; data: Uint16Array };

export const packedBytes = (p: Packed): number => p.data.byteLength;

/** RGBA -> interleaved R,G bytes. */
export function packVector(rgba: ArrayLike<number>, w: number, h: number): Packed {
  const n = w * h;
  if (rgba.length < n * 4) throw new Error(`packVector: ${rgba.length} bytes for a ${w}x${h} image`);
  const data = new Uint8Array(n * 2);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 2) {
    data[k] = rgba[j]!;
    data[k + 1] = rgba[j + 1]!;
  }
  return { kind: 'vector', w, h, data };
}

/** RGBA -> 16-bit value (R high byte, G low byte; CONTRACTS section 1b). */
export function packScalar(rgba: ArrayLike<number>, w: number, h: number): Packed {
  const n = w * h;
  if (rgba.length < n * 4) throw new Error(`packScalar: ${rgba.length} bytes for a ${w}x${h} image`);
  const data = new Uint16Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) data[i] = (rgba[j]! << 8) | rgba[j + 1]!;
  return { kind: 'scalar', w, h, data };
}
