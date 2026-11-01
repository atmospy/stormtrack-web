import type { DecodedScalar, ImageDataLike, ScalarFrameMeta, ScalarGrid, ScalarImageSource } from './types.js';

const isImageDataLike = (x: unknown): x is ImageDataLike =>
  !!x && typeof x === 'object' && 'data' in x && 'width' in (x as object) && !(x as { getContext?: unknown }).getContext;

/** Read RGBA bytes from any supported image source (browser, incl. workers) or an ImageData-like (Node). */
export function readPixels(image: ScalarImageSource | ImageDataLike): ImageDataLike {
  if (isImageDataLike(image)) return image;
  const w = (image as { width: number }).width;
  const h = (image as { height: number }).height;
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('scalar-layer: 2D canvas unavailable for decoding');
  ctx.drawImage(image as CanvasImageSource, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

/** Does the grid cover all longitudes (so that the seam at +-180 is continuous)? */
export function isGlobalLon(g: ScalarGrid): boolean {
  const dx = (g.lon_right - g.lon_left) / (g.width - 1);
  return Math.abs(dx * g.width - 360) < 0.01;
}

/** Physical value of a 16-bit code `t` in [0,1]. Shader mirrors this. */
export function codeToValue(t: number, meta: ScalarFrameMeta): number {
  const [lo, hi] = meta.range;
  if (meta.transform !== 'sqrt') return lo + t * (hi - lo);
  if (meta.rangeIn === 'encoded') {
    const s = lo + t * (hi - lo);
    return s * s;
  }
  const a = Math.sqrt(Math.max(lo, 0));
  const b = Math.sqrt(Math.max(hi, 0));
  const s = a + t * (b - a);
  return s * s;
}

/** Inverse of {@link codeToValue}: value -> 16-bit code (clamped, rounded). Used by tests/demo to build PNG data. */
export function valueToCode(x: number, meta: ScalarFrameMeta): number {
  const [lo, hi] = meta.range;
  let t: number;
  if (meta.transform !== 'sqrt') t = (x - lo) / (hi - lo);
  else if (meta.rangeIn === 'encoded') t = (Math.sqrt(Math.max(x, 0)) - lo) / (hi - lo);
  else {
    const a = Math.sqrt(Math.max(lo, 0));
    const b = Math.sqrt(Math.max(hi, 0));
    t = (Math.sqrt(Math.max(x, 0)) - a) / (b - a);
  }
  return Math.min(65535, Math.max(0, Math.round(t * 65535)));
}

/** Encode physical values to RGBA bytes following CONTRACTS §1b (R = hi byte, G = lo byte, B = 0, A = 255). */
export function encodeScalar(values: ArrayLike<number>, meta: ScalarFrameMeta): { data: Uint8ClampedArray; width: number; height: number } {
  const { width, height } = meta.grid;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const c = valueToCode(values[i]!, meta);
    data[i * 4] = c >> 8;
    data[i * 4 + 1] = c & 255;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

/**
 * Decode a scalar PNG (CONTRACTS §1b) into physical-unit floats: `v16 = R*256+G`, `t = v16/65535`, value from
 * `range` (and squared when `transform` is `"sqrt"`). The image must have been decoded without colour management.
 */
export function decodeScalarImage(image: ScalarImageSource | ImageDataLike, meta: ScalarFrameMeta): DecodedScalar {
  const px = readPixels(image);
  const g = meta.grid;
  if (px.width !== g.width || px.height !== g.height) {
    throw new Error(`scalar-layer: image is ${px.width}x${px.height} but meta says ${g.width}x${g.height}`);
  }
  const n = g.width * g.height;
  const values = new Float32Array(n);
  const d = px.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) values[i] = codeToValue((d[j]! * 256 + d[j + 1]!) / 65535, meta);
  return { values, width: g.width, height: g.height, lon_left: g.lon_left, lon_right: g.lon_right, lat_top: g.lat_top, lat_bottom: g.lat_bottom };
}

/**
 * Bilinear sample at lon/lat (degrees). Longitude wraps seamlessly on global grids; latitude clamps at the first/last
 * row; returns `null` outside the grid's lat range or outside a regional grid's lon range. Mirrors the shader exactly
 * (texel centres at integer grid nodes, interpolation of physical values).
 */
export function sampleScalar(d: DecodedScalar, lon: number, lat: number): number | null {
  const { width: w, height: h, values } = d;
  const dx = (d.lon_right - d.lon_left) / (w - 1);
  const dy = (d.lat_top - d.lat_bottom) / (h - 1);
  if (lat > d.lat_top + 1e-9 || lat < d.lat_bottom - 1e-9 || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const fy = Math.min(Math.max((d.lat_top - lat) / dy, 0), h - 1);
  let fx = (lon - d.lon_left) / dx;
  let x0: number;
  let x1: number;
  let tx: number;
  if (isGlobalLon(d)) {
    fx = ((fx % w) + w) % w;
    x0 = Math.floor(fx) % w;
    x1 = (x0 + 1) % w;
    tx = fx - Math.floor(fx);
  } else {
    if (fx < -1e-9 || fx > w - 1 + 1e-9) return null;
    fx = Math.min(Math.max(fx, 0), w - 1);
    x0 = Math.min(Math.floor(fx), Math.max(w - 2, 0));
    x1 = Math.min(x0 + 1, w - 1);
    tx = fx - x0;
  }
  const y0 = Math.min(Math.floor(fy), Math.max(h - 2, 0));
  const y1 = Math.min(y0 + 1, h - 1);
  const ty = fy - y0;
  const top = values[y0 * w + x0]! * (1 - tx) + values[y0 * w + x1]! * tx;
  const bot = values[y1 * w + x0]! * (1 - tx) + values[y1 * w + x1]! * tx;
  return top * (1 - ty) + bot * ty;
}
