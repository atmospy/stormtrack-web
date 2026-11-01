import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContractError, parseActiveStorms, parseHazardIndex, parseHazardPoints, parseHistory, parseStats, parseWindLatest } from './contracts';

const sample = (p: string) => JSON.parse(readFileSync(resolve(__dirname, '../../../../../public-data/sample', p), 'utf8'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('wind/latest.json', () => {
  it('accepts the sample', () => {
    const w = parseWindLatest(sample('wind/latest.json'));
    expect(w.frames.length).toBeGreaterThan(1);
    expect(w.image.width).toBe(720);
  });
  it('rejects a wrong schema', () => {
    const j = sample('wind/latest.json');
    j.schema = 2;
    expect(() => parseWindLatest(j)).toThrow(/unsupported schema 2/);
  });
  it('rejects non-m/s units', () => {
    const j = sample('wind/latest.json');
    j.units = 'kt';
    expect(() => parseWindLatest(j)).toThrow(/units/);
  });
  it('rejects absolute frame paths', () => {
    const j = sample('wind/latest.json');
    j.frames[0].png = '/wind/x.png';
    expect(() => parseWindLatest(j)).toThrow(/relative to the data root/);
  });
  it('rejects unsorted frames, bad times, empty frames, bad ranges', () => {
    let j = sample('wind/latest.json');
    j.frames[1].fhr = 0;
    expect(() => parseWindLatest(j)).toThrow(/sorted/);
    j = sample('wind/latest.json');
    j.run = '2026-11-01 00:00';
    expect(() => parseWindLatest(j)).toThrow(/trailing Z/);
    j = sample('wind/latest.json');
    j.frames = [];
    expect(() => parseWindLatest(j)).toThrow(/at least one frame/);
    j = sample('wind/latest.json');
    j.image.u = { min: 5, max: 5 };
    expect(() => parseWindLatest(j)).toThrow(/greater than min/);
  });
  it('error carries contract and path', () => {
    const j = sample('wind/latest.json');
    delete j.image.width;
    try {
      parseWindLatest(j);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ContractError);
      expect((e as ContractError).path).toBe('image.width');
      expect((e as Error).message).toContain('wind/latest.json');
    }
  });
});

describe('storms/active.geojson', () => {
  it('accepts the sample', () => {
    const a = parseActiveStorms(sample('storms/active.geojson'));
    const kinds = new Set(a.features.map((f) => f.properties.kind));
    expect(kinds).toEqual(new Set(['position', 'track', 'forecast', 'cone']));
  });
  it('requires wind_period_min: 1 on positions', () => {
    const j = sample('storms/active.geojson');
    delete j.features[0].properties.wind_period_min;
    expect(() => parseActiveStorms(j)).toThrow(/wind_period_min/);
  });
  it('rejects unknown kinds and mismatched arrays', () => {
    let j = sample('storms/active.geojson');
    j.features[1].properties.kind = 'blob';
    expect(() => parseActiveStorms(j)).toThrow(/unknown kind "blob"/);
    j = sample('storms/active.geojson');
    j.features[1].properties.times.pop();
    expect(() => parseActiveStorms(j)).toThrow(/vertices but/);
  });
  it('rejects out-of-range coordinates', () => {
    const j = sample('storms/active.geojson');
    j.features[0].geometry.coordinates = [200, 10];
    expect(() => parseActiveStorms(j)).toThrow(/outside -180..180/);
  });
  it('accepts null name / wind / pressure and an empty collection', () => {
    const j = clone(sample('storms/active.geojson'));
    Object.assign(j.features[0].properties, { name: null, pressure_hpa: null, wind_kt: null });
    expect(parseActiveStorms(j).features[0]!.properties).toMatchObject({ name: null, wind_kt: null });
    expect(parseActiveStorms({ type: 'FeatureCollection', features: [] }).features).toEqual([]);
  });
});

describe('history / stats / hazards', () => {
  it('accepts samples', () => {
    expect(parseHistory(sample('storms/history/NI.geojson')).features.length).toBeGreaterThan(3);
    expect(parseStats(sample('storms/stats/NI.json')).annual.length).toBeGreaterThan(10);
    expect(parseHazardIndex(sample('hazards/index.json')).layers.quakes!.count).toBeGreaterThan(0);
    expect(parseHazardPoints(sample('hazards/quakes.geojson')).features.length).toBeGreaterThan(10);
  });
  it('history rejects non-LineStrings', () => {
    const j = sample('storms/history/NI.geojson');
    j.features[0].geometry.type = 'Point';
    expect(() => parseHistory(j)).toThrow(/LineString/);
  });
  it('hazard parser drops malformed features instead of failing', () => {
    const r = parseHazardPoints({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null, properties: {} }, { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { id: 'a' } }] });
    expect(r.features).toHaveLength(1);
  });
});
