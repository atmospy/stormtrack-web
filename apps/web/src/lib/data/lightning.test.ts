import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countBySource, countInWindow, firstInWindow, inCoverage, parseCoverage, parseFlashes, parseLightningIndex } from './lightning';

const sample = (p: string) => JSON.parse(readFileSync(resolve(__dirname, '../../../../../public-data/sample', p), 'utf8'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('lightning/index.json', () => {
  it('accepts the sample and keeps stale optional', () => {
    const i = parseLightningIndex(sample('lightning/index.json'));
    expect(i.sources[0]!.id).toBe('goes-glm');
    expect(i.stale).toBe(false);
    expect(parseLightningIndex({ ...sample('lightning/index.json'), stale: true }).stale).toBe(true);
  });
  it('rejects bad schema / times / counts with the path', () => {
    const j = sample('lightning/index.json');
    expect(() => parseLightningIndex({ ...j, schema: 2 })).toThrow(/unsupported schema 2/);
    expect(() => parseLightningIndex({ ...j, updated: 'now' })).toThrow(/updated: expected UTC ISO-8601/);
    expect(() => parseLightningIndex({ ...j, count: 'many' })).toThrow(/count/);
    expect(() => parseLightningIndex({ ...j, sources: 3 })).toThrow(/sources: expected an array/);
  });
});

describe('lightning/flashes.json', () => {
  const j = () => sample('lightning/flashes.json');
  it('parses compact columns into typed arrays', () => {
    const f = parseFlashes(j());
    expect(f.n).toBeGreaterThan(1000);
    expect(f.lon).toBeInstanceOf(Float32Array);
    expect(f.t0).toBe(Date.parse('2026-11-01T19:00:00Z'));
  });
  it('finds columns by name, tolerates missing energy, and reorders', () => {
    const f = parseFlashes({ schema: 1, t0: '2026-11-01T19:00:00Z', cols: ['lat', 'lon', 'dt_s'], rows: [[10, -50, 0], [11, -51, 5]] });
    expect(Array.from(f.lon)).toEqual([-50, -51]);
    expect(Array.from(f.lat)).toEqual([10, 11]);
    expect(Array.from(f.dt)).toEqual([0, 5]);
    expect(Array.from(f.energy)).toEqual([0, 0]);
  });
  it('explains contract violations', () => {
    const bad = (mut: (x: any) => void, re: RegExp) => {
      const x = clone({ schema: 1, t0: '2026-11-01T19:00:00Z', cols: ['dt_s', 'lon', 'lat', 'energy_fj'], rows: [[0, 1, 2, 3], [1, 1, 2, 3]] });
      mut(x);
      expect(() => parseFlashes(x)).toThrow(re);
    };
    bad((x) => (x.cols = ['dt_s', 'lon']), /missing required column "lat"/);
    bad((x) => (x.rows[1][1] = 'a'), /rows\[1\]: dt_s\/lon\/lat must be finite numbers/);
    bad((x) => (x.rows[1][2] = 95), /outside lon -180\.\.180/);
    bad((x) => (x.rows[1][0] = -5), /sorted by time/);
    bad((x) => (x.rows = {}), /rows: expected an array/);
    bad((x) => (x.t0 = '2026-11-01'), /trailing Z/);
    bad((x) => (x.schema = 3), /unsupported schema 3/);
  });
  it('windows by age with binary search', () => {
    const f = parseFlashes({ schema: 1, t0: '2026-11-01T19:00:00Z', cols: ['dt_s', 'lon', 'lat'], rows: [[0, 0, 0], [60, 0, 0], [300, 0, 0], [590, 0, 0], [600, 0, 0]] });
    const now = f.t0 + 600_000;
    expect(countInWindow(f, now, 5 * 60_000)).toBe(3); // dt >= 300
    expect(countInWindow(f, now, 10 * 60_000)).toBe(5);
    expect(firstInWindow(f, now, 60_000)).toBe(3);
    expect(countInWindow(f, f.t0 + 100_000, 60_000)).toBe(1); // future flashes are not counted
    expect(countInWindow(f, now + 3600_000, 60_000)).toBe(0);
  });
});

describe('lightning section 6.1 (multi-source)', () => {
  it('parses the src column, null energy and per-source metadata', () => {
    const idx = parseLightningIndex(sample('lightning/index.json'));
    expect(idx.sources.map((s) => [s.id, s.unofficial, s.time_precision])).toEqual([['goes-glm', false, 'exact'], ['damini', true, 'bucketed']]);
    expect(idx.sources[1]!.attribution).toMatch(/IITM/);
    const f = parseFlashes(sample('lightning/flashes.json'));
    expect(new Set(f.src)).toEqual(new Set([0, 1]));
    for (let i = 0; i < f.n; i++) if (f.src[i] === 1) expect(f.energy[i]).toBe(0); // null energy -> default size
  });
  it('rejects a bad src index and accepts the 4-column form', () => {
    expect(() => parseFlashes({ schema: 1, t0: '2026-11-01T19:00:00Z', cols: ['dt_s', 'lon', 'lat', 'src'], rows: [[0, 1, 2, 'x']] })).toThrow(/rows\[0\]\.src/);
    const f = parseFlashes({ schema: 1, t0: '2026-11-01T19:00:00Z', cols: ['dt_s', 'lon', 'lat', 'energy_fj'], rows: [[0, 1, 2, 3]] });
    expect(Array.from(f.src)).toEqual([0]);
  });
  it('counts per source in a window and a view box', () => {
    const f = parseFlashes({ schema: 1, t0: '2026-11-01T19:00:00Z', cols: ['src', 'dt_s', 'lon', 'lat'], rows: [[0, 0, 10, 10], [1, 1, 80, 20], [1, 2, 81, 21], [0, 3, -90, 30]] });
    const now = f.t0 + 10_000;
    expect(countBySource(f, now, 60_000, null, 2)).toEqual([2, 2]);
    expect(countBySource(f, now, 60_000, { west: 60, south: 0, east: 100, north: 40 }, 2)).toEqual([0, 2]);
    expect(countBySource(f, now, 60_000, { west: 170, south: -90, east: -80, north: 90 }, 2)).toEqual([1, 0]); // wraps the antimeridian
  });
  it('coverage is the union of per-source features', () => {
    const cov = parseCoverage(sample('lightning/coverage.geojson'));
    expect(cov.features).toHaveLength(2);
    expect(inCoverage(cov, 80, 18)).toBe(true); // India rectangle
    expect(inCoverage(cov, 10, 50)).toBe(false);
  });
});

describe('lightning/coverage.geojson', () => {
  it('accepts collections, features and bare geometries', () => {
    const cov = parseCoverage(sample('lightning/coverage.geojson'));
    expect(cov.features.length).toBe(2);
    const geom = cov.features[0]!.geometry;
    expect(parseCoverage(geom).features).toHaveLength(1);
    expect(parseCoverage({ type: 'Feature', properties: {}, geometry: geom }).features).toHaveLength(1);
  });
  it('rejects non-polygons and empty collections', () => {
    expect(() => parseCoverage({ type: 'Point', coordinates: [0, 0] })).toThrow(/expected Polygon or MultiPolygon/);
    expect(() => parseCoverage({ type: 'FeatureCollection', features: [] })).toThrow(/no polygon geometry/);
  });
  it('point-in-coverage: Americas yes, South Asia no, holes excluded', () => {
    const cov = parseCoverage(sample('lightning/coverage.geojson'));
    expect(inCoverage(cov, -90, 28)).toBe(true);
    expect(inCoverage(cov, -60, -20)).toBe(true);
    expect(inCoverage(cov, 10, 50)).toBe(false);
    const donut = parseCoverage({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] });
    expect(inCoverage(donut, 2, 2)).toBe(true);
    expect(inCoverage(donut, 5, 5)).toBe(false);
  });
});
