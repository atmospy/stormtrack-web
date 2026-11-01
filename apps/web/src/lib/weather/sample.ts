import type { VectorRange, WeatherGrid } from '#lib/data/weather';
import { windFromDeg } from '#lib/util/storm';
import type { Packed } from './pack';

export interface WindSample {
  u: number;
  v: number;
  speed: number;
  /** meteorological direction the wind blows FROM, degrees clockwise from north */
  deg: number;
}

/**
 * Scalar decode (CONTRACTS section 1b): v16 -> value. With transform "sqrt" the stored quantity is sqrt(x) and
 * the producer's [min,max] range describes x, so the packing range is [sqrt(min), sqrt(max)] and we square on decode.
 * (Open contract question: the text does not say whether `range` is in x or sqrt(x) units; see README.)
 */
export function decodeScalar(v16: number, range: [number, number], transform?: 'sqrt'): number {
  if (transform === 'sqrt') {
    const lo = Math.sqrt(Math.max(0, range[0]));
    const hi = Math.sqrt(Math.max(0, range[1]));
    const y = lo + (v16 / 65535) * (hi - lo);
    return y * y;
  }
  return range[0] + (v16 / 65535) * (range[1] - range[0]);
}

interface Cell {
  i00: number;
  i10: number;
  i01: number;
  i11: number;
  tx: number;
  ty: number;
}
/** Bilinear cell for lon/lat on the grid; longitude wraps, null outside the latitude range. */
export function cellAt(grid: WeatherGrid, w: number, h: number, lon: number, lat: number): Cell | null {
  if (!(lat <= grid.lat_top + 1e-9 && lat >= grid.lat_bottom - 1e-9) || !Number.isFinite(lon)) return null;
  const dx = (grid.lon_right - grid.lon_left) / (w - 1);
  const dy = (grid.lat_top - grid.lat_bottom) / (h - 1);
  const span = 360 / dx;
  const global = Math.abs(dx * w - 360) < 0.01;
  let fx = (lon - grid.lon_left) / dx;
  if (global) fx = ((fx % span) + span) % span;
  else if (fx < 0 || fx > w - 1) return null;
  const fy = Math.min(Math.max((grid.lat_top - lat) / dy, 0), h - 1);
  const x0 = Math.floor(fx), y0 = Math.min(Math.floor(fy), Math.max(0, h - 2));
  const wrapX = (x: number) => (global ? ((x % w) + w) % w : Math.min(x, w - 1));
  const xa = wrapX(x0), xb = wrapX(x0 + 1);
  const ya = y0, yb = Math.min(y0 + 1, h - 1);
  return { i00: ya * w + xa, i10: ya * w + xb, i01: yb * w + xa, i11: yb * w + xb, tx: fx - x0, ty: fy - y0 };
}

export function sampleVector(p: Packed, grid: WeatherGrid, range: VectorRange, lon: number, lat: number): WindSample | null {
  if (p.kind !== 'vector') return null;
  const c = cellAt(grid, p.w, p.h, lon, lat);
  if (!c) return null;
  const d = p.data;
  const mix = (ch: 0 | 1) => {
    const a = d[c.i00 * 2 + ch]!, b = d[c.i10 * 2 + ch]!, e = d[c.i01 * 2 + ch]!, f = d[c.i11 * 2 + ch]!;
    return (a * (1 - c.tx) + b * c.tx) * (1 - c.ty) + (e * (1 - c.tx) + f * c.tx) * c.ty;
  };
  const u = range.u[0] + (mix(0) / 255) * (range.u[1] - range.u[0]);
  const v = range.v[0] + (mix(1) / 255) * (range.v[1] - range.v[0]);
  return { u, v, speed: Math.hypot(u, v), deg: windFromDeg(u, v) };
}

export function sampleScalar(p: Packed, grid: WeatherGrid, range: [number, number], transform: 'sqrt' | undefined, lon: number, lat: number): number | null {
  if (p.kind !== 'scalar') return null;
  const c = cellAt(grid, p.w, p.h, lon, lat);
  if (!c) return null;
  const d = p.data;
  const v16 = (d[c.i00]! * (1 - c.tx) + d[c.i10]! * c.tx) * (1 - c.ty) + (d[c.i01]! * (1 - c.tx) + d[c.i11]! * c.tx) * c.ty;
  return decodeScalar(v16, range, transform);
}
