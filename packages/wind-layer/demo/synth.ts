import type { WindImageMeta } from '../src/index.js';

export const SYNTH_META: WindImageMeta = {
  width: 720,
  height: 361,
  lon_left: -180,
  lon_right: 179.5,
  lat_top: 90,
  lat_bottom: -90,
  u: { min: -50, max: 50 },
  v: { min: -50, max: 50 },
  speed_max: 70,
};

const gauss = (d: number, s: number) => Math.exp(-(d * d) / (2 * s * s));

/** Procedural wind: trade winds + mid-latitude westerlies + a jet + a cyclone vortex that moves with `t` (0..1). */
export function synthWind(t: number): ImageData {
  const m = SYNTH_META;
  const img = new ImageData(m.width, m.height);
  const cx = 78 + 6 * t; // cyclone centre, Bay of Bengal drifting NW->NE
  const cy = 13 + 5 * t;
  for (let y = 0; y < m.height; y++) {
    const lat = m.lat_top - y * 0.5;
    for (let x = 0; x < m.width; x++) {
      const lon = m.lon_left + x * 0.5;
      // zonal background: easterly trades (-8 m/s) near 15N/S, westerlies (+10) near 45N/S
      let u = -8 * gauss(Math.abs(lat) - 15, 12) + 10 * gauss(Math.abs(lat) - 45, 12);
      let v = 3 * Math.sin((lon * Math.PI) / 60 + t * 2) * gauss(Math.abs(lat) - 40, 15);
      // jet stream: 35 m/s westerly band at 45N with meanders
      const jetLat = 45 + 6 * Math.sin((lon * Math.PI) / 50 + t * 1.5);
      u += 35 * gauss(lat - jetLat, 5);
      // tropical cyclone: Rankine-like vortex, counter-clockwise (N hemisphere)
      let dx = (lon - cx) * Math.cos((cy * Math.PI) / 180);
      if (dx > 180) dx -= 360;
      if (dx < -180) dx += 360;
      const dy = lat - cy;
      const r = Math.hypot(dx, dy) + 1e-6;
      const rmax = 1.6;
      const vt = r < rmax ? 42 * (r / rmax) : 42 * Math.pow(rmax / r, 0.7) * gauss(r, 14);
      u += (-dy / r) * vt;
      v += (dx / r) * vt;
      const i = (y * m.width + x) * 4;
      img.data[i] = Math.round(((Math.min(Math.max(u, m.u.min), m.u.max) - m.u.min) / (m.u.max - m.u.min)) * 255);
      img.data[i + 1] = Math.round(((Math.min(Math.max(v, m.v.min), m.v.max) - m.v.min) / (m.v.max - m.v.min)) * 255);
      img.data[i + 2] = Math.round((Math.min(Math.hypot(u, v), m.speed_max) / m.speed_max) * 255);
      img.data[i + 3] = 255;
    }
  }
  return img;
}

const bmpOpts: ImageBitmapOptions = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
export const toBitmap = (d: ImageData) => createImageBitmap(d, bmpOpts);
export const blobToBitmap = (b: Blob) => createImageBitmap(b, bmpOpts);
