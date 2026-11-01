import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContractError, parseWindLatest } from './contracts';
import { modelFromLegacyWind, parseWeatherIndex, parseWeatherModel, windMetaFor } from './weather';

const sample = (p: string) => JSON.parse(readFileSync(resolve(__dirname, '../../../../../public-data/sample', p), 'utf8'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('weather/index.json', () => {
  it('accepts the sample catalogue', () => {
    const idx = parseWeatherIndex(sample('weather/index.json'));
    expect(idx.models.map((m) => m.id)).toEqual(['gfs', 'ecmwf-ifs']);
  });
  it('rejects wrong schema, empty and duplicate models, absolute pointers, bad time', () => {
    const j = sample('weather/index.json');
    expect(() => parseWeatherIndex({ ...j, schema: 1 })).toThrow(/unsupported schema 1/);
    expect(() => parseWeatherIndex({ ...j, models: [] })).toThrow(/at least one model/);
    expect(() => parseWeatherIndex({ ...j, models: [j.models[0], j.models[0]] })).toThrow(/duplicate model id "gfs"/);
    const abs = clone(j);
    abs.models[0].latest = '/weather/gfs/latest.json';
    expect(() => parseWeatherIndex(abs)).toThrow(/relative to the data root/);
    const bad = clone(j);
    bad.models[0].run = '2026-11-01 00:00';
    expect(() => parseWeatherIndex(bad)).toThrow(/trailing Z/);
  });
});

describe('weather/<model>/latest.json', () => {
  const gfs = () => sample('weather/gfs/latest.json');
  it('accepts the sample models', () => {
    const m = parseWeatherModel(gfs(), 'gfs');
    expect(m.fields.filter((f) => f.kind === 'vector').length).toBe(4);
    const precip = m.fields.find((f) => f.id === 'precip')!;
    expect(precip.kind === 'scalar' && precip.transform).toBe('sqrt');
    expect(parseWeatherModel(sample('weather/ecmwf-ifs/latest.json'), 'ecmwf-ifs').fields.length).toBe(4);
  });
  it('names the offending path for every kind of violation', () => {
    const t = (mut: (j: any) => void, re: RegExp) => {
      const j = clone(gfs());
      mut(j);
      expect(() => parseWeatherModel(j, 'gfs')).toThrow(re);
    };
    t((j) => (j.schema = 1), /unsupported schema 1/);
    t((j) => (j.model = 'ecmwf-ifs'), /file says "ecmwf-ifs" but the catalogue listed "gfs"/);
    t((j) => (j.grid.width = 1), /width\/height/);
    t((j) => (j.grid.lat_top = -100), /lat_top must be > lat_bottom/);
    t((j) => (j.fields = []), /at least one field/);
    t((j) => (j.fields[0].kind = 'tensor'), /fields\[0\]\.kind/);
    t((j) => (j.fields[1].slug = j.fields[0].slug), /duplicate slug/);
    t((j) => (j.fields[0].slug = 'Wind 10'), /slug must match/);
    t((j) => (j.fields[0].units = 'kt'), /vector fields must be in "m\/s"/);
    t((j) => (j.fields[0].range.speed_max = 0), /speed_max/);
    t((j) => (j.fields[0].range.u = [5, -5]), /fields\[0\]\.range\.u: max/);
    t((j) => (j.fields[0].frames[0].png = 'https://x/y.png'), /frames\[0\]\.png: must be relative/);
    t((j) => (j.fields[0].frames[1].fhr = -1), /sorted by increasing fhr/);
    t((j) => (j.fields[0].frames = []), /at least one frame/);
    t((j) => (j.fields[0].frames[0].valid = 'tomorrow'), /trailing Z/);
    const si = gfs().fields.findIndex((f: any) => f.kind === 'scalar');
    t((j) => (j.fields[si].range = [1]), /expected \[min, max\]/);
    t((j) => (j.fields[si].transform = 'log'), /unknown transform "log"|unknown transform/);
  });
  it('reports a ContractError with contract + path', () => {
    const j = gfs();
    j.fields[0].frames = 'nope';
    try {
      parseWeatherModel(j, 'gfs');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractError);
      expect((e as ContractError).message).toContain('weather/gfs/latest.json');
    }
  });
});

describe('legacy wind adapter', () => {
  it('wraps wind/latest.json as a one-field GFS model that the v2 parser accepts', () => {
    const legacy = parseWindLatest(sample('wind/latest.json'));
    const m = modelFromLegacyWind(legacy);
    expect(m.fields).toHaveLength(1);
    expect(m.fields[0]!.id).toBe('wind@10m');
    expect(() => parseWeatherModel(JSON.parse(JSON.stringify(m)), 'gfs')).not.toThrow();
    const f = m.fields[0]!;
    if (f.kind !== 'vector') throw new Error('expected vector');
    expect(windMetaFor(m.grid, f)).toMatchObject({ width: 720, u: { min: -50, max: 50 }, speed_max: 70 });
  });
});
