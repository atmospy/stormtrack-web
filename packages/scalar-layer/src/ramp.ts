import type { ScalarRamp } from './types.js';

/**
 * Built-in ramps. Stops are ABSOLUTE physical values; the layer spreads them over the frame's range.
 * Rationale is in the README ("Colour ramps"). All were chosen to read on a near-black basemap.
 */
export const SCALAR_RAMPS: Record<'temperature' | 'pressure' | 'precipitation' | 'viridis', ScalarRamp> = {
  // Windy-style "weather" scale over the range people actually see (-30..45 degC; values outside clamp to the end
  // colours): violet -> blue -> cyan -> green -> yellow -> orange -> red -> crimson. Roughly one distinct hue
  // step per 5 degC so a 3 degC difference is visible, including between 25 and 35 degC where most of the tropics sit.
  temperature: {
    name: 'temperature',
    unit: '°C',
    stops: [
      [-30, '#8a4fd8'],
      [-20, '#5a52e6'],
      [-10, '#2f7cf2'],
      [-5, '#2da4f0'],
      [0, '#27c6e6'],
      [5, '#25d4b4'],
      [10, '#4fdc7a'],
      [15, '#9ce63f'],
      [20, '#e8e83a'],
      [25, '#f9c52f'],
      [28, '#f9a02b'],
      [31, '#f67a28'],
      [34, '#ee542a'],
      [37, '#e03030'],
      [40, '#c4203e'],
      [45, '#8c1664'],
    ],
  },
  // Deliberately low-contrast slate: blue-grey lows, neutral 1013, warm-grey highs, mostly translucent so
  // isobars and H/L markers carry the information.
  pressure: {
    name: 'pressure',
    unit: 'hPa',
    stops: [
      [940, '#2f4a7a'],
      [980, '#3f5b86'],
      [1000, '#52688a'],
      [1013, '#68758c'],
      [1026, '#85817f'],
      [1040, '#9a8878'],
      [1060, '#ab9078'],
    ],
  },
  // Radar-style rain: pale blue drizzle -> blue -> green -> yellow -> orange -> red -> magenta. Dry areas are fully
  // transparent; light rain is already clearly visible (opaque enough), heavy rain is solid.
  precipitation: {
    name: 'precipitation',
    unit: 'mm',
    stops: [
      [0, '#6cc8ff00'],
      [0.25, '#6cc8ff00'],
      [0.5, '#7fd0ff66'],
      [1, '#4aa8ffcc'],
      [1.5, '#2f80f0dd'],
      [2, '#26c46ae6'],
      [4, '#7bdc3cea'],
      [7, '#f2e83aee'],
      [12, '#f5a52cf0'],
      [20, '#ee4a2af2'],
      [35, '#c01a5cf4'],
      [60, '#a020c8f6'],
      [100, '#f0c8ffff'],
    ],
  },
  // matplotlib viridis (perceptually uniform, CVD-safe); positions are fractions of the range.
  viridis: {
    name: 'viridis',
    normalized: true,
    stops: [
      [0, '#440154'],
      [0.111, '#482878'],
      [0.222, '#3e4989'],
      [0.333, '#31688e'],
      [0.444, '#26828e'],
      [0.556, '#1f9e89'],
      [0.667, '#35b779'],
      [0.778, '#6ece58'],
      [0.889, '#b5de2b'],
      [1, '#fde725'],
    ],
  },
};

const NAMED: Record<string, [number, number, number, number]> = {
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  transparent: [0, 0, 0, 0],
};

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() and a few names. */
export function parseCssColor(css: string): [number, number, number, number] {
  const s = css.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1]!, +m[2]!, +m[3]!, a];
  }
  if (NAMED[s]) return NAMED[s]!;
  throw new Error(`scalar-layer: cannot parse colour "${css}"`);
}

const toLin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055);

/** sRGB (0..255) -> Oklab. Interpolating there keeps steps perceptually even (sRGB lerp muddies the mid-tones). */
export function toOklab(r: number, g: number, b: number): [number, number, number] {
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function fromOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const cl = (x: number) => Math.min(255, Math.max(0, Math.round(toSrgb(x))));
  return [cl(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), cl(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), cl(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

/** Position of texel `i` of a `size`-texel LUT, as a fraction 0..1 of the value range. */
export const lutT = (i: number, size: number): number => i / (size - 1);

/**
 * Rasterise a ramp over `range` into a `size`x1 RGBA8 strip (NOT premultiplied; Oklab interpolation, linear alpha).
 * `sqrtSpace`: texel positions are linear in sqrt(value) (used for `transform:"sqrt"` fields so small values get
 * resolution); the shader indexes the strip with the same warp.
 */
export function buildRampLUT(ramp: ScalarRamp, range: [number, number], sqrtSpace = false, size = 512): Uint8Array {
  if (!ramp.stops.length) throw new Error('scalar-layer: ramp needs at least one stop');
  const [lo, hi] = range;
  const span = hi - lo || 1;
  const st = [...ramp.stops]
    .sort((p, q) => p[0] - q[0])
    .map(([v, c]) => {
      const rgba = parseCssColor(c);
      return { v: ramp.normalized ? lo + v * span : v, ok: toOklab(rgba[0], rgba[1], rgba[2]), a: rgba[3] };
    });
  const out = new Uint8Array(size * 4);
  const a0 = Math.sqrt(Math.max(lo, 0));
  const b0 = Math.sqrt(Math.max(hi, 0));
  let k = 0;
  for (let i = 0; i < size; i++) {
    const t = lutT(i, size);
    let v: number;
    if (sqrtSpace) {
      const s = a0 + t * (b0 - a0);
      v = s * s;
    } else v = lo + t * span;
    while (k < st.length - 2 && v > st[k + 1]!.v) k++;
    const A = st[Math.min(k, st.length - 1)]!;
    const B = st[Math.min(k + 1, st.length - 1)]!;
    const d = B.v - A.v;
    const u = d <= 0 ? (v >= B.v ? 1 : 0) : Math.min(Math.max((v - A.v) / d, 0), 1);
    const rgb = fromOklab(A.ok[0] + (B.ok[0] - A.ok[0]) * u, A.ok[1] + (B.ok[1] - A.ok[1]) * u, A.ok[2] + (B.ok[2] - A.ok[2]) * u);
    out[i * 4] = rgb[0];
    out[i * 4 + 1] = rgb[1];
    out[i * 4 + 2] = rgb[2];
    out[i * 4 + 3] = Math.round((A.a + (B.a - A.a) * u) * 255);
  }
  return out;
}

/** Colour a single value through a ramp (CPU; legends, tests). Returns [r,g,b,a] with a in 0..255. */
export function rampColorAt(ramp: ScalarRamp, range: [number, number], value: number, sqrtSpace = false): [number, number, number, number] {
  const size = 512;
  const lut = buildRampLUT(ramp, range, sqrtSpace, size);
  const [lo, hi] = range;
  let t: number;
  if (sqrtSpace) {
    const a = Math.sqrt(Math.max(lo, 0));
    const b = Math.sqrt(Math.max(hi, 0));
    t = (Math.sqrt(Math.max(value, 0)) - a) / (b - a || 1);
  } else t = (value - lo) / (hi - lo || 1);
  const i = Math.round(Math.min(Math.max(t, 0), 1) * (size - 1));
  return [lut[i * 4]!, lut[i * 4 + 1]!, lut[i * 4 + 2]!, lut[i * 4 + 3]!];
}
