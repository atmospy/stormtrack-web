import type { ColorRamp } from './types.js';

/**
 * Default speed colour ramp, tuned for dark basemaps. Hue walks cyan -> green -> yellow -> orange ->
 * magenta as speed rises, so speed reads as a familiar "cool -> hot" sequence; every stop stays bright
 * (HSL lightness ~55-65 %) so even the calmest wind remains visible on a near-black ocean, and the
 * strongest winds end in a pale pink so extremes glow. Hue alone is not colourblind-safe (green vs
 * orange), but lightness also rises from the cyan/green end to the yellow peak, which keeps ordering readable.
 */
export const DEFAULT_COLOR_RAMP: ColorRamp = [
  [0, '#4cc9ff'],
  [3, '#2ee6c4'],
  [7, '#6fe85c'],
  [11, '#e8e43a'],
  [16, '#ffa02e'],
  [22, '#ff4f6a'],
  [29, '#f23fd0'],
  [40, '#ffc4f3'],
];

const NAMED: Record<string, [number, number, number, number]> = {
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1],
  cyan: [0, 255, 255, 1],
  magenta: [255, 0, 255, 1],
  orange: [255, 165, 0, 1],
  transparent: [0, 0, 0, 0],
};

/** Parse #rgb, #rrggbb, #rrggbbaa, rgb()/rgba() and a few names. Falls back to a 2D canvas for anything else (browser). */
export function parseCssColor(css: string): [number, number, number, number] {
  const s = css.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length === 6 || h.length === 8) {
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1]!, +m[2]!, +m[3]!, a];
  }
  if (NAMED[s]) return NAMED[s]!;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas').getContext('2d');
    if (c) {
      c.fillStyle = '#000';
      c.fillStyle = css;
      return parseCssColor(c.fillStyle as string);
    }
  }
  throw new Error(`wind-layer: cannot parse colour "${css}"`);
}

export interface RampTexture {
  /** size x 1 RGBA8, NOT premultiplied */
  data: Uint8Array;
  size: number;
  /** speed (m/s) that the last texel stands for */
  maxSpeed: number;
}

/** Rasterise a ramp into a `size`x1 RGBA8 strip covering [0, last stop speed]; linear interpolation in sRGB. */
export function buildColorRamp(stops: ColorRamp, size = 256): RampTexture {
  if (!stops.length) throw new Error('wind-layer: colorRamp needs at least one stop');
  const sorted = [...stops].sort((a, b) => a[0] - b[0]).map(([s, c]) => ({ s, c: parseCssColor(c) }));
  const maxSpeed = Math.max(sorted[sorted.length - 1]!.s, 1e-6);
  const data = new Uint8Array(size * 4);
  let k = 0;
  for (let i = 0; i < size; i++) {
    const sp = (i / (size - 1)) * maxSpeed;
    while (k < sorted.length - 2 && sp > sorted[k + 1]!.s) k++;
    const a = sorted[Math.min(k, sorted.length - 1)]!;
    const b = sorted[Math.min(k + 1, sorted.length - 1)]!;
    const span = b.s - a.s;
    const t = span <= 0 ? 0 : Math.min(Math.max((sp - a.s) / span, 0), 1);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(a.c[c]! + (b.c[c]! - a.c[c]!) * t);
    data[i * 4 + 3] = Math.round((a.c[3] + (b.c[3] - a.c[3]) * t) * 255);
  }
  return { data, size, maxSpeed };
}
