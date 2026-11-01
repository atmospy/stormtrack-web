import type { WindImageMeta } from '#lib/data/contracts';
import { windFromDeg } from '#lib/util/storm';

export interface WindSample {
  u: number;
  v: number;
  speed: number;
  /** meteorological direction the wind blows FROM, degrees clockwise from north */
  deg: number;
}

/** CPU copy of one wind frame for point sampling (readout, conditions card, arrow field). */
export class WindField {
  private readonly px: Uint8ClampedArray;
  constructor(
    readonly meta: WindImageMeta,
    pixels: Uint8ClampedArray
  ) {
    this.px = pixels;
  }

  static fromImage(meta: WindImageMeta, img: ImageBitmap): WindField {
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    return new WindField({ ...meta, width: img.width, height: img.height }, data);
  }

  private uv(ix: number, iy: number): [number, number] {
    const { width: w, height: h, u, v } = this.meta;
    const x = ((ix % w) + w) % w;
    const y = Math.max(0, Math.min(h - 1, iy));
    const i = (y * w + x) * 4;
    return [u.min + (this.px[i]! / 255) * (u.max - u.min), v.min + (this.px[i + 1]! / 255) * (v.max - v.min)];
  }

  /** Bilinear sample; null outside the latitude range. Longitude wraps. */
  sample(lon: number, lat: number): WindSample | null {
    const m = this.meta;
    if (lat > m.lat_top || lat < m.lat_bottom) return null;
    const dx = (m.lon_right - m.lon_left) / (m.width - 1);
    const dy = (m.lat_top - m.lat_bottom) / (m.height - 1);
    let fx = (lon - m.lon_left) / dx;
    // wrap into [0, 360/dx)
    const span = 360 / dx;
    fx = ((fx % span) + span) % span;
    const fy = (m.lat_top - lat) / dy;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const a = this.uv(x0, y0), b = this.uv(x0 + 1, y0), c = this.uv(x0, y0 + 1), d = this.uv(x0 + 1, y0 + 1);
    const lerp = (i: 0 | 1) => (a[i] * (1 - tx) + b[i] * tx) * (1 - ty) + (c[i] * (1 - tx) + d[i] * tx) * ty;
    const u = lerp(0), v = lerp(1);
    return { u, v, speed: Math.hypot(u, v), deg: windFromDeg(u, v) };
  }
}
