import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLOR_RAMP,
  buildColorRamp,
  decodeWindImage,
  isGlobalLon,
  parseCssColor,
  sampleField,
  sampleWind,
  toSample,
  type WindImageMeta,
} from '../src/index.js';

const meta = (w: number, h: number, extra: Partial<WindImageMeta> = {}): WindImageMeta => ({
  width: w,
  height: h,
  lon_left: -180,
  lon_right: 180 - 360 / w,
  lat_top: 90,
  lat_bottom: -90,
  u: { min: -50, max: 50 },
  v: { min: -50, max: 50 },
  speed_max: 70,
  ...extra,
});

/** Encode exactly like the contract's producer. */
function encode(m: WindImageMeta, uf: (x: number, y: number) => number, vf: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(m.width * m.height * 4);
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++) {
      const u = uf(x, y);
      const v = vf(x, y);
      const i = (y * m.width + x) * 4;
      data[i] = Math.round(((u - m.u.min) / (m.u.max - m.u.min)) * 255);
      data[i + 1] = Math.round(((v - m.v.min) / (m.v.max - m.v.min)) * 255);
      data[i + 2] = Math.round((Math.min(Math.hypot(u, v), m.speed_max) / m.speed_max) * 255);
      data[i + 3] = 255;
    }
  return { data, width: m.width, height: m.height };
}

describe('decodeWindImage', () => {
  it('round-trips within one quantisation step of the contract encoding', () => {
    const m = meta(72, 37);
    const uf = (x: number, y: number) => 30 * Math.sin(x / 7) - y * 0.1;
    const vf = (x: number, y: number) => 25 * Math.cos(y / 5) + x * 0.05;
    const f = decodeWindImage(encode(m, uf, vf), m);
    const step = 100 / 255;
    for (let y = 0; y < m.height; y += 3)
      for (let x = 0; x < m.width; x += 5) {
        expect(Math.abs(f.u[y * m.width + x]! - uf(x, y))).toBeLessThanOrEqual(step / 2 + 1e-4);
        expect(Math.abs(f.v[y * m.width + x]! - vf(x, y))).toBeLessThanOrEqual(step / 2 + 1e-4);
      }
  });
  it('maps byte 0 and 255 to min and max exactly', () => {
    const m = meta(2, 1, { u: { min: -10, max: 20 }, v: { min: 0, max: 5 } });
    const f = decodeWindImage({ data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 0, 255]), width: 2, height: 1 }, m);
    expect([f.u[0], f.u[1], f.v[0], f.v[1]]).toEqual([-10, 20, 0, 5]);
  });
  it('rejects a size mismatch', () => {
    expect(() => decodeWindImage({ data: new Uint8ClampedArray(16), width: 2, height: 2 }, meta(4, 4))).toThrow(/2x2/);
  });
});

describe('speed / direction', () => {
  it('u>0, v=0 is a wind FROM the west (270)', () => expect(toSample(5, 0).deg).toBeCloseTo(270));
  it('u<0 is from the east (90)', () => expect(toSample(-5, 0).deg).toBeCloseTo(90));
  it('v>0 is from the south (180), v<0 from the north (0)', () => {
    expect(toSample(0, 5).deg).toBeCloseTo(180);
    expect(toSample(0, -5).deg).toBeCloseTo(0);
  });
  it('NE-bound wind comes from the SW (225)', () => expect(toSample(3, 3).deg).toBeCloseTo(225));
  it('speed is the magnitude; calm gives deg 0', () => {
    expect(toSample(3, 4).speed).toBe(5);
    expect(toSample(0, 0).deg).toBe(0);
  });
});

describe('bilinear sampling', () => {
  const m = meta(8, 5); // dlon 45, dlat 45
  const ramp = (x: number) => x; // u = column index
  const f = decodeWindImage(
    // exact floats: build the field by hand
    encode(m, (x) => (x / 7) * 50 - 25 + 0, () => 0),
    m,
  );
  it('is exact on grid nodes', () => {
    const s = sampleField(f, m, -180 + 45 * 3, 90 - 45 * 2)!;
    expect(s.u).toBeCloseTo(f.u[2 * 8 + 3]!, 5);
  });
  it('interpolates linearly between nodes', () => {
    const a = f.u[2 * 8 + 3]!;
    const b = f.u[2 * 8 + 4]!;
    expect(sampleField(f, m, -180 + 45 * 3.5, 0)!.u).toBeCloseTo((a + b) / 2, 5);
    void ramp;
  });
  it('wraps longitude across the +-180 seam (last column blends into column 0)', () => {
    const last = f.u[2 * 8 + 7]!;
    const first = f.u[2 * 8 + 0]!;
    const lonMid = -180 + 45 * 7.5; // halfway between last node (135) and wrapped first node (180 == -180)
    expect(sampleField(f, m, lonMid, 0)!.u).toBeCloseTo((last + first) / 2, 5);
    // seam equivalence
    expect(sampleField(f, m, 180, 0)!.u).toBeCloseTo(sampleField(f, m, -180, 0)!.u, 5);
    expect(sampleField(f, m, 190, 10)!.u).toBeCloseTo(sampleField(f, m, -170, 10)!.u, 5);
    expect(sampleField(f, m, -545, 10)!.u).toBeCloseTo(sampleField(f, m, 175, 10)!.u, 5);
  });
  it('clamps at the poles and never reads out of bounds', () => {
    for (const lat of [90, -90, 89.999, -89.999])
      for (const lon of [-180, -90, 0, 179.9]) {
        const s = sampleField(f, m, lon, lat)!;
        expect(Number.isFinite(s.u)).toBe(true);
      }
    expect(sampleField(f, m, 0, 90)!.u).toBeCloseTo(f.u[0 * 8 + 4]! , 5);
    expect(sampleField(f, m, 0, -90)!.u).toBeCloseTo(f.u[4 * 8 + 4]!, 5);
    expect(sampleField(f, m, 0, 91)).toBeNull();
  });
  it('returns null outside a regional grid and does not wrap', () => {
    const r = meta(10, 10, { lon_left: 60, lon_right: 100, lat_top: 30, lat_bottom: 0 });
    expect(isGlobalLon(r)).toBe(false);
    const rf = decodeWindImage(encode(r, () => 10, () => -5), r);
    expect(sampleField(rf, r, 80, 15)!.u).toBeCloseTo(10, 0);
    expect(sampleField(rf, r, 59, 15)).toBeNull();
    expect(sampleField(rf, r, 101, 15)).toBeNull();
    expect(sampleWind(rf, r, 80, 15)!.deg).toBeGreaterThan(0);
  });
  it('detects a global 0.5 degree contract grid', () => expect(isGlobalLon(meta(720, 361, { lon_right: 179.5 }))).toBe(true));
});

describe('colour ramp', () => {
  it('parses common css colours', () => {
    expect(parseCssColor('#f00')).toEqual([255, 0, 0, 1]);
    expect(parseCssColor('#00ff0080')[3]).toBeCloseTo(128 / 255, 2);
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 1]);
    expect(parseCssColor('rgba(1,2,3,0.5)')).toEqual([1, 2, 3, 0.5]);
  });
  it('builds a 256x1 strip hitting the first and last stops and interpolating between', () => {
    const r = buildColorRamp([[0, '#000000'], [10, '#ffffff'], [20, '#ff0000']], 256);
    expect(r.data.length).toBe(256 * 4);
    expect(r.maxSpeed).toBe(20);
    expect([...r.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...r.data.slice(-4)]).toEqual([255, 0, 0, 255]);
    const mid = r.data.slice(Math.round(127.5) * 4, Math.round(127.5) * 4 + 3);
    expect(mid[0]).toBeGreaterThan(240); // near the white stop at 10 m/s
    expect(mid[2]).toBeGreaterThan(200);
  });
  it('default ramp is ascending, valid, and starts bright enough for dark maps', () => {
    const speeds = DEFAULT_COLOR_RAMP.map((s) => s[0]);
    expect([...speeds].sort((a, b) => a - b)).toEqual(speeds);
    const r = buildColorRamp(DEFAULT_COLOR_RAMP);
    const lum = (i: number) => 0.2126 * r.data[i * 4]! + 0.7152 * r.data[i * 4 + 1]! + 0.0722 * r.data[i * 4 + 2]!;
    for (let i = 0; i < 256; i += 8) expect(lum(i)).toBeGreaterThan(110);
  });
});
