import type { ImageDataLike, WindImageMeta, WindImageSource, WindSample } from './types.js';

export interface WindField {
  /** eastward wind, m/s, row-major, row 0 = lat_top */
  u: Float32Array;
  /** northward wind, m/s */
  v: Float32Array;
  width: number;
  height: number;
}

const isImageDataLike = (x: unknown): x is ImageDataLike =>
  !!x && typeof x === 'object' && 'data' in x && 'width' in (x as object) && !(x as { getContext?: unknown }).getContext;

/** Read RGBA bytes from any supported image source (browser) or ImageData-like (Node). */
export function readPixels(image: WindImageSource | ImageDataLike): ImageDataLike {
  if (isImageDataLike(image)) return image;
  const w = (image as { width: number }).width;
  const h = (image as { height: number }).height;
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('wind-layer: 2D canvas unavailable for decoding');
  ctx.drawImage(image as CanvasImageSource, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Decode a wind PNG into float u/v fields in m/s following CONTRACTS §1:
 * `R = (u-u.min)/(u.max-u.min)*255`, `G` likewise for v.
 */
export function decodeWindImage(image: WindImageSource | ImageDataLike, meta: WindImageMeta): WindField {
  const px = readPixels(image);
  if (px.width !== meta.width || px.height !== meta.height) {
    throw new Error(`wind-layer: image is ${px.width}x${px.height} but meta says ${meta.width}x${meta.height}`);
  }
  const n = meta.width * meta.height;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const us = (meta.u.max - meta.u.min) / 255;
  const vs = (meta.v.max - meta.v.min) / 255;
  const d = px.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    u[i] = meta.u.min + d[j]! * us;
    v[i] = meta.v.min + d[j + 1]! * vs;
  }
  return { u, v, width: meta.width, height: meta.height };
}

/** Does the grid cover all longitudes (so that the seam at +-180 is continuous)? */
export function isGlobalLon(meta: WindImageMeta): boolean {
  const dx = (meta.lon_right - meta.lon_left) / (meta.width - 1);
  return Math.abs(dx * meta.width - 360) < 0.01;
}

/** u/v (m/s) -> speed and meteorological direction (FROM, degrees, 0 = N). */
export function toSample(u: number, v: number): WindSample {
  const speed = Math.hypot(u, v);
  let deg = (Math.atan2(-u, -v) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  if (deg >= 360) deg -= 360;
  if (speed < 1e-9) deg = 0;
  return { u, v, speed, deg };
}

/**
 * Bilinear sample of a decoded field at lon/lat (degrees). Longitude wraps seamlessly on global grids;
 * latitude clamps at the first/last row (poles). Returns `null` outside a regional grid.
 * Mirrors the shader exactly (texel centres at integer grid nodes).
 */
export function sampleField(field: WindField, meta: WindImageMeta, lon: number, lat: number): { u: number; v: number } | null {
  const { width: w, height: h } = field;
  const dx = (meta.lon_right - meta.lon_left) / (w - 1);
  const dy = (meta.lat_top - meta.lat_bottom) / (h - 1);
  if (lat > meta.lat_top + 1e-9 || lat < meta.lat_bottom - 1e-9) return null;
  let fy = (meta.lat_top - lat) / dy;
  fy = Math.min(Math.max(fy, 0), h - 1);
  let fx = (lon - meta.lon_left) / dx;
  let x0: number;
  let x1: number;
  if (isGlobalLon(meta)) {
    fx = ((fx % w) + w) % w;
    x0 = Math.floor(fx);
    x1 = (x0 + 1) % w;
  } else {
    if (fx < -1e-9 || fx > w - 1 + 1e-9) return null;
    fx = Math.min(Math.max(fx, 0), w - 1);
    x0 = Math.min(Math.floor(fx), w - 2);
    x1 = x0 + 1;
  }
  const tx = fx - Math.floor(fx);
  const y0 = Math.min(Math.floor(fy), h - 2 < 0 ? 0 : h - 2);
  const y1 = Math.min(y0 + 1, h - 1);
  const ty = fy - y0;
  const bil = (a: Float32Array) => {
    const top = a[y0 * w + x0]! * (1 - tx) + a[y0 * w + x1]! * tx;
    const bot = a[y1 * w + x0]! * (1 - tx) + a[y1 * w + x1]! * tx;
    return top * (1 - ty) + bot * ty;
  };
  return { u: bil(field.u), v: bil(field.v) };
}

/** Convenience: sample + speed/direction. */
export function sampleWind(field: WindField, meta: WindImageMeta, lon: number, lat: number): WindSample | null {
  const s = sampleField(field, meta, lon, lat);
  return s ? toSample(s.u, s.v) : null;
}
