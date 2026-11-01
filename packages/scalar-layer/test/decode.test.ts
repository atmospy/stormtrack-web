import { describe, expect, it } from 'vitest';
import { codeToValue, decodeScalarImage, encodeScalar, sampleScalar, valueToCode, type ScalarFrameMeta } from '../src/index.js';

const grid = (w: number, h: number, global = true) => ({
  width: w,
  height: h,
  lon_left: -180,
  lon_right: global ? 180 - 360 / w : 0,
  lat_top: 90,
  lat_bottom: -90,
});

const img = (w: number, h: number, codes: number[]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  codes.forEach((c, i) => {
    data[i * 4] = c >> 8;
    data[i * 4 + 1] = c & 255;
    data[i * 4 + 3] = 255;
  });
  return { data, width: w, height: h };
};

describe('decodeScalarImage (CONTRACTS 1b)', () => {
  it('reconstructs R*256+G over range', () => {
    const meta: ScalarFrameMeta = { grid: grid(4, 1), range: [930, 1070] };
    const d = decodeScalarImage(img(4, 1, [0, 65535, 32768, 1]), meta);
    expect(d.values[0]).toBeCloseTo(930, 4);
    expect(d.values[1]).toBeCloseTo(1070, 3);
    expect(d.values[2]).toBeCloseTo(930 + (32768 / 65535) * 140, 3);
    expect(d.values[3]).toBeCloseTo(930 + (1 / 65535) * 140, 4);
  });

  it('is exactly monotonic across every byte boundary (the case hardware bilinear gets wrong)', () => {
    const meta: ScalarFrameMeta = { grid: grid(1024, 1), range: [0, 65535] };
    const codes = [255, 256, 257, 511, 512, 513, 767, 768, 65279, 65280, 65534, 65535];
    const d = decodeScalarImage(img(codes.length, 1, codes), { ...meta, grid: grid(codes.length, 1) });
    codes.forEach((c, i) => expect(d.values[i]).toBeCloseTo(c, 1));
    for (let i = 1; i < codes.length; i++) expect(d.values[i]!).toBeGreaterThan(d.values[i - 1]!);
  });

  it('round-trips encode -> decode within half a code step', () => {
    const meta: ScalarFrameMeta = { grid: grid(8, 4), range: [-60, 60] };
    const vals = Array.from({ length: 32 }, (_, i) => -60 + (120 * i) / 31 + 0.0123);
    const d = decodeScalarImage(encodeScalar(vals, meta), meta);
    const step = 120 / 65535;
    vals.forEach((v, i) => expect(Math.abs(d.values[i]! - Math.min(v, 60))).toBeLessThanOrEqual(step / 2 + 1e-4));
  });

  it('sqrt transform: physical range, squares on decode, keeps resolution at low values', () => {
    const meta: ScalarFrameMeta = { grid: grid(5, 1), range: [0, 100], transform: 'sqrt' };
    const vals = [0, 0.1, 1, 25, 100];
    const d = decodeScalarImage(encodeScalar(vals, meta), meta);
    vals.forEach((v, i) => expect(d.values[i]).toBeCloseTo(v, 2));
    // code for 25 mm is half scale (sqrt(25)/sqrt(100)) -> 32768 +- 1
    expect(Math.abs(valueToCode(25, meta) - 32768)).toBeLessThanOrEqual(1);
    // resolution at 0.1 mm better than 0.001 mm
    expect(codeToValue((valueToCode(0.1, meta) + 1) / 65535, meta) - codeToValue(valueToCode(0.1, meta) / 65535, meta)).toBeLessThan(0.001);
  });

  it('sqrt transform with range bounding sqrt(x) (literal contract reading)', () => {
    const meta: ScalarFrameMeta = { grid: grid(3, 1), range: [0, 10], transform: 'sqrt', rangeIn: 'encoded' };
    const d = decodeScalarImage(encodeScalar([0, 4, 100], meta), meta);
    expect(Array.from(d.values)).toEqual([0, expect.closeTo(4, 2), expect.closeTo(100, 1)]);
  });

  it('rejects size mismatches', () => {
    expect(() => decodeScalarImage(img(2, 1, [0, 0]), { grid: grid(3, 1), range: [0, 1] })).toThrow(/2x1/);
  });
});

describe('sampleScalar', () => {
  const W = 8, H = 5;
  const make = (f: (lon: number, lat: number) => number, g = grid(W, H)) => {
    const values = new Float32Array(g.width * g.height);
    const dx = (g.lon_right - g.lon_left) / (g.width - 1);
    const dy = (g.lat_top - g.lat_bottom) / (g.height - 1);
    for (let j = 0; j < g.height; j++) for (let i = 0; i < g.width; i++) values[j * g.width + i] = f(g.lon_left + i * dx, g.lat_top - j * dy);
    return { ...g, values };
  };

  it('is exact on grid nodes and reproduces a linear field between nodes', () => {
    const d = make((lon, lat) => 3 + 0.01 * lat); // linear in lat only (lon-periodic)
    expect(sampleScalar(d, -180, 90)).toBeCloseTo(3.9, 5);
    expect(sampleScalar(d, 17.3, 33.3)).toBeCloseTo(3 + 0.01 * 33.3, 5);
    expect(sampleScalar(d, -45, -90)).toBeCloseTo(2.1, 5);
  });

  it('wraps in longitude on global grids (seam between last and first column)', () => {
    const d = make((lon) => (lon === -180 ? 100 : lon === 135 ? 0 : 50));
    // dx = 45; last column lon=135, first -180: halfway across the seam is 157.5 == -202.5
    expect(sampleScalar(d, 157.5, 0)).toBeCloseTo(50, 5);
    const e = make((lon) => (lon === -180 ? 100 : lon === 135 ? 0 : 50));
    expect(sampleScalar(e, 157.5, 0)).toBeCloseTo(50, 5);
    expect(sampleScalar(e, -202.5, 0)).toBeCloseTo(50, 5);
    expect(sampleScalar(e, 157.5 + 720, 0)).toBeCloseTo(50, 5);
    expect(sampleScalar(e, 180, 0)).toBeCloseTo(100, 5); // 180 == -180
    expect(sampleScalar(e, 135 + 22.5, 10)).toBeCloseTo(50, 5);
  });

  it('seam interpolation is continuous', () => {
    const vals = [10, 0, 0, 0, 0, 0, 0, 20];
    const g = grid(8, 1);
    const d = { ...g, values: Float32Array.from(vals) };
    // between col 7 (lon 135, 20) and col 0 (lon -180 == 180, 10): at 157.5 -> 15
    expect(sampleScalar(d, 157.5, 90)).toBeCloseTo(15, 5);
    expect(sampleScalar(d, 135 + 11.25, 90)).toBeCloseTo(17.5, 5);
  });

  it('poles: clamps to the edge rows, null beyond the grid latitude', () => {
    const d = make((lon, lat) => lat);
    expect(sampleScalar(d, 10, 90)).toBeCloseTo(90, 5);
    expect(sampleScalar(d, 10, -90)).toBeCloseTo(-90, 5);
    expect(sampleScalar(d, 10, 90.5)).toBeNull();
    expect(sampleScalar(d, NaN, 0)).toBeNull();
  });

  it('regional grids return null outside their lon range', () => {
    const g = { ...grid(5, 3, false), lon_left: 60, lon_right: 100 };
    const d = make((lon) => lon, g);
    expect(sampleScalar(d, 80, 0)).toBeCloseTo(80, 5);
    expect(sampleScalar(d, 101, 0)).toBeNull();
    expect(sampleScalar(d, 59, 0)).toBeNull();
    expect(sampleScalar(d, 100, 0)).toBeCloseTo(100, 5);
  });
});
