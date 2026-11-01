import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { historyVertices, parseHistory } from './contracts';
import { parseHistoryIndex, seasonLabel } from './history';

const sample = (p: string) => JSON.parse(readFileSync(resolve(__dirname, '../../../../../public-data/sample', p), 'utf8'));

describe('storms/history/all-index.json', () => {
  it('accepts the sample (all seven basins, canonical order)', () => {
    const i = parseHistoryIndex(sample('storms/history/all-index.json'));
    expect(i.basins.map((b) => b.code)).toEqual(['NA', 'EP', 'WP', 'NI', 'SI', 'SP', 'SA']);
    expect(i.basins.find((b) => b.code === 'NI')!.count).toBe(12);
    expect(i.basins[0]).toMatchObject({ code: 'NA', name: 'North Atlantic', file: 'storms/history/NA.geojson', stats: 'storms/stats/NA.json' });
    expect(i.basins[0]!.gzip_bytes).toBeGreaterThan(100);
  });
  it('also reads storms/index.json#history, array form and a bare map', () => {
    const idx = sample('storms/index.json');
    expect(parseHistoryIndex(idx).basins).toHaveLength(7);
    expect(parseHistoryIndex({ basins: [{ code: 'WP', count: 3, year_min: 1990, year_max: 2000 }] }).basins[0]!.code).toBe('WP');
    expect(parseHistoryIndex({ NI: { count: 1, year_min: 2000, year_max: 2001 } }).basins[0]!.code).toBe('NI');
  });
  it('rejects with clear messages', () => {
    expect(() => parseHistoryIndex(null)).toThrow(/expected an object/);
    expect(() => parseHistoryIndex({ basins: {} })).toThrow(/no basin entries/);
    expect(() => parseHistoryIndex({ basins: { NI: { count: 'x', year_min: 1, year_max: 2 } } })).toThrow(/basins\.NI\.count/);
    expect(() => parseHistoryIndex({ basins: { NI: { count: 1, year_min: 2005, year_max: 2000 } } })).toThrow(/year_max \(2000\) < year_min/);
    expect(() => parseHistoryIndex({ basins: [{ id: 'NI', count: 1, year_min: 1, year_max: 2, file: '/abs.geojson' }] })).toThrow(/basins\.NI\.file: must be a path relative/);
    expect(() => parseHistoryIndex({ basins: [{ count: 1, year_min: 1, year_max: 2 }] })).toThrow(/need an "id"/);
  });
});

describe('history geometry', () => {
  const feat = (geometry: unknown) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: { id: 'X', year: 2000 } }] });
  it('accepts MultiLineString (tracks split at the antimeridian) and exposes all vertices', () => {
    const h = parseHistory(feat({ type: 'MultiLineString', coordinates: [[[179, 10], [180, 11]], [[-180, 11], [-179, 12]]] }));
    expect(historyVertices(h.features[0]!.geometry)).toHaveLength(4);
  });
  it('rejects other geometries and bad coordinates with the path', () => {
    expect(() => parseHistory(feat({ type: 'Point', coordinates: [0, 0] }))).toThrow(/expected LineString or MultiLineString, got "Point"/);
    expect(() => parseHistory(feat({ type: 'MultiLineString', coordinates: [[[200, 0], [1, 1]]] }))).toThrow(/coordinates\[0\]\[0\]\[0\]: longitude 200/);
  });
});

describe('seasons', () => {
  it('southern basins label July-June seasons by the year they end', () => {
    expect(seasonLabel(2027, 'SI')).toBe('2026-27');
    expect(seasonLabel(2000, 'SP')).toBe('1999-00');
    expect(seasonLabel(2026, 'NA')).toBe('2026');
    expect(seasonLabel(2026, null)).toBe('2026');
  });
});

describe('sample history files', () => {
  it('every basin file parses and matches the index count', () => {
    const idx = parseHistoryIndex(sample('storms/history/all-index.json'));
    for (const b of idx.basins) {
      const h = parseHistory(sample(`storms/history/${b.code}.geojson`));
      expect(h.features.length).toBe(b.count);
      expect(Math.min(...h.features.map((f) => f.properties.year))).toBe(b.year_min);
    }
  });
});
