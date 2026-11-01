import { describe, expect, it } from 'vitest';
import { buildIsobarSet, buildIsobars, splitAtAntimeridian, type DecodedScalar } from '../src/index.js';

type Fn = (lon: number, lat: number) => number;
function field(f: Fn, w: number, h: number, lonL: number, lonR: number, latT: number, latB: number): DecodedScalar {
  const values = new Float32Array(w * h);
  const dx = (lonR - lonL) / (w - 1);
  const dy = (latT - latB) / (h - 1);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) values[j * w + i] = f(lonL + i * dx, latT - j * dy);
  return { values, width: w, height: h, lon_left: lonL, lon_right: lonR, lat_top: latT, lat_bottom: latB };
}
const parts = (f: { geometry: { type: string; coordinates: any } }): Array<Array<[number, number]>> =>
  f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;

describe('buildIsobars', () => {
  it('radial low -> closed circles at the right radii', () => {
    // regional 0.1 deg grid, 1000 + r(deg) * 1, centred on (10, 5)
    const d = field((lon, lat) => 1000 + Math.hypot(lon - 10, lat - 5), 201, 201, 0, 20, 15, -5);
    const fc = buildIsobars(d, { interval: 2, base: 1000 });
    // r = 2..8 fit inside the domain (r >= 10 hits the edge and is open)
    const circles = fc.features.filter((f) => f.properties.value <= 1008);
    expect(circles.map((f) => f.properties.value)).toEqual([1002, 1004, 1006, 1008]);
    for (const f of circles) {
      expect(f.geometry.type).toBe('LineString');
      const c = parts(f)[0]!;
      expect(c[0]).toEqual(c[c.length - 1]); // closed ring
      const r = f.properties.value - 1000;
      for (const [x, y] of c) expect(Math.abs(Math.hypot(x - 10, y - 5) - r)).toBeLessThan(0.02);
    }
  });

  it('plane -> straight lines at the right positions', () => {
    const d = field((lon) => 1000 + lon, 101, 51, 0, 50, 25, 0);
    const fc = buildIsobars(d, { interval: 10, base: 1000 });
    expect(fc.features.map((f) => f.properties.value)).toEqual([1010, 1020, 1030, 1040, 1050]);
    for (const f of fc.features) {
      const xs = parts(f)[0]!.map((p) => p[0]);
      for (const x of xs) expect(x).toBeCloseTo(f.properties.value - 1000, 3);
    }
    // interior lines span the full latitude extent
    const mid = fc.features.find((f) => f.properties.value === 1020)!;
    const ys = parts(mid)[0]!.map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
    expect(Math.max(...ys)).toBeCloseTo(25, 5);
  });

  it('respects base offset and flags major lines', () => {
    const d = field((lon) => 1002 + lon, 101, 11, 0, 50, 5, 0);
    const fc = buildIsobars(d, { interval: 5, base: 1000, majorEvery: 2 });
    const byVal = Object.fromEntries(fc.features.map((f) => [f.properties.value, f.properties.major]));
    expect(byVal[1005]).toBe(false);
    expect(byVal[1010]).toBe(true);
  });

  it('antimeridian: a low centred on +-180 yields lines split at the seam with coords inside [-180,180]', () => {
    const wrapD = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
    const d = field((lon, lat) => 1000 + Math.hypot(wrapD(lon - 180), lat), 360, 181, -180, 179, 90, -90);
    const fc = buildIsobars(d, { interval: 5, base: 1000 });
    expect(fc.features.length).toBeGreaterThanOrEqual(3);
    for (const f of fc.features.filter((x) => x.properties.value <= 1040)) {
      const r = f.properties.value - 1000;
      expect(f.geometry.type).toBe('MultiLineString');
      expect(parts(f)).toHaveLength(2);
      const ends: number[] = [];
      for (const part of parts(f)) {
        for (const [x, y] of part) {
          expect(x).toBeGreaterThanOrEqual(-180);
          expect(x).toBeLessThanOrEqual(180);
          expect(Math.abs(Math.hypot(wrapD(x - 180), y) - r)).toBeLessThan(0.05);
        }
        ends.push(part[0]![0], part[part.length - 1]![0]);
      }
      // each part ends on the seam (+-180) on both sides
      for (const x of ends) expect(Math.abs(x)).toBeCloseTo(180, 5);
    }
  });

  it('a ring that does not touch the seam stays a single closed LineString on a global grid', () => {
    const d = field((lon, lat) => 1000 + Math.hypot(lon, lat), 360, 181, -180, 179, 90, -90);
    const fc = buildIsobars(d, { interval: 5, base: 1000 });
    const f = fc.features.find((x) => x.properties.value === 1010)!;
    expect(f.geometry.type).toBe('LineString');
    const c = parts(f)[0]!;
    expect(c[0]).toEqual(c[c.length - 1]);
  });

  it('smoothing keeps lines on the circle (to within the chord sag)', () => {
    const d = field((lon, lat) => 1000 + Math.hypot(lon - 10, lat - 5), 41, 41, 0, 20, 15, -5);
    const fc = buildIsobars(d, { interval: 4, base: 1000, smooth: 2 });
    for (const f of fc.features) for (const [x, y] of parts(f)[0]!) expect(Math.abs(Math.hypot(x - 10, y - 5) - (f.properties.value - 1000))).toBeLessThan(0.1);
  });

  it('NaN cells are skipped without crashing', () => {
    const d = field((lon) => 1000 + lon, 21, 11, 0, 20, 10, 0);
    d.values[5] = NaN;
    expect(() => buildIsobars(d, { interval: 5 })).not.toThrow();
  });
});

describe('labels and centres', () => {
  const low = field((lon, lat) => 1000 + Math.hypot(lon - 10, lat - 5) * 2, 201, 201, 0, 20, 15, -5);
  it('H/L centres: one L at the minimum', () => {
    const set = buildIsobarSet(low, { interval: 4, extremaRadius: 6 });
    const L = set.centres.features.filter((f) => f.properties.type === 'L');
    expect(L).toHaveLength(1);
    expect(L[0]!.geometry.coordinates[0]).toBeCloseTo(10, 1);
    expect(L[0]!.geometry.coordinates[1]).toBeCloseTo(5, 1);
    expect(L[0]!.properties.value).toBeCloseTo(1000, 1);
  });
  it('labels sit on their line, carry text and an upright angle', () => {
    const set = buildIsobarSet(low, { interval: 4, labelSpacing: 4, minLabelLength: 1 });
    expect(set.labels.features.length).toBeGreaterThan(3);
    for (const l of set.labels.features) {
      const [x, y] = l.geometry.coordinates;
      expect(Math.abs(Math.hypot(x - 10, y - 5) - (l.properties.value - 1000) / 2)).toBeLessThan(0.05);
      expect(l.properties.text).toBe(String(l.properties.value));
      expect(Math.abs(l.properties.angle)).toBeLessThanOrEqual(90);
    }
  });
});

describe('splitAtAntimeridian', () => {
  it('splits an eastward crossing and interpolates latitude', () => {
    const out = splitAtAntimeridian([[170, 0], [190, 10]]);
    expect(out).toEqual([[[170, 0], [180, 5]], [[-180, 5], [-170, 10]]]);
  });
  it('splits a westward crossing', () => {
    const out = splitAtAntimeridian([[-170, 0], [-190, 10]]);
    expect(out).toEqual([[[-170, 0], [-180, 5]], [[180, 5], [170, 10]]]);
  });
  it('leaves seam-free lines alone', () => {
    expect(splitAtAntimeridian([[0, 0], [10, 10]])).toEqual([[[0, 0], [10, 10]]]);
  });
});
