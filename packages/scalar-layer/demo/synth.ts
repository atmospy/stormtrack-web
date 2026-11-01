import { encodeScalar, type ScalarFrameMeta } from '../src/index.js';

const grid = { width: 720, height: 361, lon_left: -180, lon_right: 179.5, lat_top: 90, lat_bottom: -90 };
export const SYNTH_META = {
  mslp: { grid, range: [930, 1070] } as ScalarFrameMeta,
  t2m: { grid, range: [-60, 60] } as ScalarFrameMeta,
  precip: { grid, range: [0, 100], transform: 'sqrt' } as ScalarFrameMeta,
};
export type SynthField = keyof typeof SYNTH_META;

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const gauss = (r2: number, s: number) => Math.exp(-r2 / (2 * s * s));
/** squared distance in degrees (lon scaled by cos(lat), wrap-safe) */
const d2 = (lon: number, lat: number, clon: number, clat: number) => {
  const dx = wrap(lon - clon) * Math.cos((lat * Math.PI) / 180);
  return dx * dx + (lat - clat) ** 2;
};

/** Cyclone-like low in the Bay of Bengal (moves with t), a high over the NE Pacific, a low straddling the antimeridian. */
function fieldAt(kind: SynthField, lon: number, lat: number, t: number): number {
  const cy = 15 + 4 * t, cx = 85 - 3 * t;
  if (kind === 'mslp') {
    const base = 1013 + 6 * Math.cos((lat * Math.PI) / 30 + 0.5) + 3 * Math.sin((lon * Math.PI) / 90);
    return base - 62 * gauss(d2(lon, lat, cx, cy), 5) + 14 * gauss(d2(lon, lat, -140 + 4 * t, 35), 14) - 28 * gauss(d2(lon, lat, 178 + 3 * t, 52), 11) + 6 * gauss(d2(lon, lat, 20, -35), 16);
  }
  if (kind === 't2m') {
    return 31 - 0.9 * Math.abs(lat) - 0.0035 * lat * lat + 5 * Math.sin((lon * Math.PI) / 60) * Math.cos((lat * Math.PI) / 180) - 12 * gauss(d2(lon, lat, cx, cy), 8);
  }
  const rain = 60 * gauss(d2(lon, lat, cx, cy), 4.5) + 18 * gauss(d2(lon, lat, wrap(178 + 3 * t), 52), 7) + 14 * Math.max(0, Math.sin((lon * Math.PI) / 25) * gauss(lat * lat, 9));
  return Math.max(0, rain);
}

export function synthImage(kind: SynthField, t: number): ImageData {
  const meta = SYNTH_META[kind];
  const { width, height, lon_left, lat_top } = meta.grid;
  const vals = new Float32Array(width * height);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) vals[j * width + i] = fieldAt(kind, lon_left + i * 0.5, lat_top - j * 0.5, t);
  const e = encodeScalar(vals, meta);
  return new ImageData(e.data as unknown as Uint8ClampedArray<ArrayBuffer>, width, height);
}

export async function toBitmap(img: ImageData): Promise<ImageBitmap> {
  return createImageBitmap(img, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

export async function blobToBitmap(b: Blob): Promise<ImageBitmap> {
  return createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}
