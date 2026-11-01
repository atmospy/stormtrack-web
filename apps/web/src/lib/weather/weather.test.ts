import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { parseWeatherModel, type ScalarField, type VectorField, type WeatherGrid, type WeatherModel } from '#lib/data/weather';
import { packScalar, packVector, type Packed } from './pack';
import { cellAt, decodeScalar, sampleScalar, sampleVector } from './sample';
import { levelDescription, levelKey, levelsOf, nearestIndex, primaryField, scalarField, timeline, variablesOf, windFieldAt } from './select';
import { buildMeteogram, meteogramFrames } from './series';
import { FrameStore, frameKey, type Decode, type FrameRef } from './store';

const root = resolve(__dirname, '../../../../../public-data/sample');
const model = (id: string) => parseWeatherModel(JSON.parse(readFileSync(resolve(root, `weather/${id}/latest.json`), 'utf8')), id);
const gfs = model('gfs');
const ifs = model('ecmwf-ifs');

/** Decode a committed sample PNG with pngjs (node has no createImageBitmap). */
function packFrame(m: WeatherModel, f: VectorField | ScalarField, i: number): Packed {
  const png = PNG.sync.read(readFileSync(resolve(root, f.frames[i]!.png)));
  return f.kind === 'vector' ? packVector(png.data, png.width, png.height) : packScalar(png.data, png.width, png.height);
}

const grid: WeatherGrid = { width: 4, height: 3, lon_left: -180, lon_right: 90, lat_top: 90, lat_bottom: -90 }; // global, 90 deg spacing
const rgba = (px: number[][]) => Uint8Array.from(px.flat());

describe('decodeScalar', () => {
  it('maps v16 linearly onto the range', () => {
    expect(decodeScalar(0, [930, 1070])).toBe(930);
    expect(decodeScalar(65535, [930, 1070])).toBe(1070);
    expect(decodeScalar(32768, [-60, 60])).toBeCloseTo(0.0009, 3);
  });
  it('squares sqrt-encoded values over the sqrt of the range', () => {
    expect(decodeScalar(0, [0, 100], 'sqrt')).toBe(0);
    expect(decodeScalar(65535, [0, 100], 'sqrt')).toBeCloseTo(100, 9);
    expect(decodeScalar(32768, [0, 100], 'sqrt')).toBeCloseTo(25, 1);
  });
});

describe('packing', () => {
  it('keeps R,G for vectors and R<<8|G for scalars', () => {
    const px = rgba([[10, 20, 30, 255], [255, 0, 0, 255]]);
    const v = packVector(px, 2, 1);
    expect(Array.from(v.data)).toEqual([10, 20, 255, 0]);
    const s = packScalar(px, 2, 1);
    expect(Array.from(s.data)).toEqual([(10 << 8) | 20, 255 << 8]);
  });
  it('rejects truncated pixel buffers', () => {
    expect(() => packScalar(new Uint8Array(4), 2, 2)).toThrow(/packScalar/);
  });
});

describe('cellAt / bilinear sampling', () => {
  const rows = (vals: number[][]) => vals.map((r) => r.map((v) => [v >> 8, v & 255, 0, 255])).flat();
  // 4x3 scalar image; value = column * 1000 (+ row * 10)
  const px = rgba(rows([[0, 1000, 2000, 3000], [10, 1010, 2010, 3010], [20, 1020, 2020, 3020]]));
  const p = packScalar(px, 4, 3);
  const raw = (lon: number, lat: number) => sampleScalar(p, grid, [0, 65535], undefined, lon, lat)!;
  it('returns node values exactly and interpolates between them', () => {
    expect(raw(-180, 90)).toBeCloseTo(0, 6);
    expect(raw(-90, 90)).toBeCloseTo(1000, 6);
    expect(raw(-135, 90)).toBeCloseTo(500, 6);
    expect(raw(-180, 45)).toBeCloseTo(5, 6);
    expect(raw(-135, 45)).toBeCloseTo(505, 6);
    expect(raw(0, -90)).toBeCloseTo(2020, 6);
  });
  it('wraps longitude on a global grid (seam between the last and first column)', () => {
    expect(raw(180, 90)).toBeCloseTo(raw(-180, 90), 6);
    expect(raw(135, 90)).toBeCloseTo((3000 + 0) / 2, 6); // halfway between col 3 and col 0
    expect(raw(-225, 90)).toBeCloseTo(raw(135, 90), 6);
    expect(raw(540, 0)).toBeCloseTo(raw(180, 0), 6);
  });
  it('returns null outside the latitude range and for non-finite input', () => {
    expect(cellAt(grid, 4, 3, 0, 91)).toBeNull();
    expect(cellAt(grid, 4, 3, NaN, 0)).toBeNull();
  });
  it('is null for the wrong kind of frame', () => {
    expect(sampleVector(p, grid, { u: [0, 1], v: [0, 1], speed_max: 1 }, 0, 0)).toBeNull();
    expect(sampleScalar(packVector(px, 4, 3), grid, [0, 1], undefined, 0, 0)).toBeNull();
  });
  it('does not wrap a regional grid, and returns null outside it', () => {
    const reg: WeatherGrid = { width: 4, height: 3, lon_left: 60, lon_right: 90, lat_top: 30, lat_bottom: 0 };
    expect(cellAt(reg, 4, 3, 59, 10)).toBeNull();
    expect(cellAt(reg, 4, 3, 91, 10)).toBeNull();
    expect(cellAt(reg, 4, 3, 75, 15)).not.toBeNull();
  });
  it('decodes vectors with the field range and gives meteorological direction', () => {
    // u=+10 (westerly wind blows to the east => from the west = 270 deg), v=0, uniform field in range [-20,20]
    const R = Math.round(((10 + 20) / 40) * 255), G = Math.round((20 / 40) * 255);
    const vp = packVector(rgba(Array(12).fill([R, G, 0, 255])), 4, 3);
    const s = sampleVector(vp, grid, { u: [-20, 20], v: [-20, 20], speed_max: 30 }, 33, 12)!;
    expect(s.u).toBeCloseTo(10, 0);
    expect(Math.abs(s.v)).toBeLessThan(0.2); // 8-bit quantisation: half a step is 0.08 m/s
    expect(s.speed).toBeCloseTo(10, 0);
    expect(Math.abs(s.deg - 270)).toBeLessThan(1.5);
  });
});

describe('select', () => {
  it('lists levels in display order and labels heights', () => {
    expect(levelsOf(gfs)).toEqual(['10m', '850', '500', '250']);
    expect(levelsOf(ifs)).toEqual(['10m', '850']);
    expect(levelDescription('850')).toBe('850 hPa ≈ 1.5 km');
    expect(levelDescription('10m')).toBe('10 m');
    expect(levelDescription('250')).toBe('250 hPa ≈ 10.5 km');
  });
  it('shows only the variables a model has', () => {
    expect(variablesOf(gfs)).toEqual(['wind', 'pressure', 'temperature', 'precipitation']);
    expect(variablesOf(ifs)).toEqual(['wind', 'pressure', 'temperature']);
    expect(scalarField(ifs, 'precipitation')).toBeNull();
  });
  it('falls back to the surface level when a model lacks the requested level', () => {
    expect(levelKey(windFieldAt(ifs, '250')!)).toBe('10m');
    expect(levelKey(windFieldAt(gfs, '500')!)).toBe('500');
    expect(primaryField(gfs, 'pressure', '850')!.id).toBe('mslp');
  });
  it('keeps the valid time across models, nearest frame otherwise', () => {
    const times = timeline(gfs.fields[0]!); // 0, 12, 24, 36 h
    const h = 3600e3, t0 = times[0]!;
    expect(nearestIndex(times, t0 + 12 * h)).toBe(1);
    expect(nearestIndex(times, t0 + 17 * h)).toBe(1);
    expect(nearestIndex(times, t0 + 18 * h)).toBe(1); // tie -> earlier
    expect(nearestIndex(times, t0 + 19 * h)).toBe(2);
    expect(nearestIndex(times, t0 - 99 * h)).toBe(0);
    expect(nearestIndex(times, t0 + 999 * h)).toBe(3);
    expect(nearestIndex([], 5)).toBe(0);
  });
});

describe('meteogram series (from committed sample frames)', () => {
  const lookup = (m: WeatherModel) => (f: VectorField | ScalarField, i: number) => packFrame(m, f, i);
  it('requests wind 10 m, mslp, t2m and precip for every frame', () => {
    expect(meteogramFrames(gfs)).toHaveLength(4 * 4);
    expect(meteogramFrames(ifs)).toHaveLength(3 * 4); // no precip in the IFS sample
  });
  it('builds all series with physically sensible values near the sample cyclone', () => {
    const g = buildMeteogram(gfs, 88.5, 14, lookup(gfs));
    expect(g.pending).toBe(0);
    expect(g.wind).toHaveLength(4);
    expect(g.wind[0]!.speed).toBeGreaterThan(20); // inside the 42 m/s vortex
    expect(g.mslp[0]!.value).toBeLessThan(990); // the low
    expect(g.t2m[0]!.value).toBeGreaterThan(15);
    expect(g.precip[0]!.value).toBeCloseTo(0, 1); // frame 0 is zeros
    expect(g.precip[1]!.value).toBeGreaterThan(5);
    expect(g.precip[1]!.hours).toBe(12);
    expect(g.precip[0]!.hours).toBe(0);
    // far from the storm the pressure is near normal
    const calm = buildMeteogram(gfs, 20, 70, lookup(gfs));
    expect(calm.mslp[0]!.value).toBeGreaterThan(995);
  });
  it('is partial while frames are still loading, null-filled, with a pending count', () => {
    const only = (f: VectorField | ScalarField, i: number) => (f.id === 'mslp' && i < 2 ? packFrame(gfs, f, i) : null);
    const part = buildMeteogram(gfs, 0, 0, only);
    expect(part.mslp.map((x) => x !== null)).toEqual([true, true, false, false]);
    expect(part.wind.every((x) => x === null)).toBe(true);
    expect(part.pending).toBe(16 - 2);
    expect(part.total).toBe(16);
  });
  it('model switch changes the values at the same valid time (ecmwf-ifs sample is offset)', () => {
    const a = buildMeteogram(gfs, 100, 40, lookup(gfs));
    const b = buildMeteogram(ifs, 100, 40, lookup(ifs));
    expect(a.t2m[0]!.t).toBe(b.t2m[0]!.t);
    expect(a.t2m[0]!.value).not.toBeCloseTo(b.t2m[0]!.value, 3);
    expect(b.precip).toHaveLength(0);
  });
});

describe('FrameStore', () => {
  const field = gfs.fields.find((f) => f.id === 'mslp')!;
  const ref = (index: number, f = field): FrameRef => ({ base: '/data/sample', model: gfs, field: f, index });
  const fake = (): { decode: Decode; calls: string[] } => {
    const calls: string[] = [];
    const decode: Decode = async (url, kind, bitmap) => {
      calls.push(url);
      await Promise.resolve();
      return { packed: kind === 'scalar' ? { kind, w: 2, h: 2, data: new Uint16Array(4) } : { kind, w: 2, h: 2, data: new Uint8Array(8) }, bitmap: bitmap ? ({ close() {} } as unknown as ImageBitmap) : undefined };
    };
    return { decode, calls };
  };
  it('keys are run-stamped and unique per frame', () => {
    expect(frameKey(ref(0))).toBe(`gfs@${gfs.run}/mslp/0`);
    expect(frameKey(ref(1))).not.toBe(frameKey(ref(0)));
  });
  it('de-duplicates concurrent requests and serves repeats from cache', async () => {
    const { decode, calls } = fake();
    const s = new FrameStore({ packedBytes: 1e9, bitmaps: 8 }, decode);
    await Promise.all([s.ensure(ref(0), false), s.ensure(ref(0), false), s.ensure(ref(0), false)]);
    await s.ensure(ref(0), false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`/data/sample/${field.frames[0]!.png}`);
    expect(s.peekPacked(ref(0))).not.toBeNull();
    expect(s.peekBitmap(ref(0))).toBeNull();
  });
  it('upgrades to a bitmap later without losing the packed grid, and reuses an in-flight bitmap request', async () => {
    const { decode, calls } = fake();
    const s = new FrameStore({ packedBytes: 1e9, bitmaps: 8 }, decode);
    await Promise.all([s.ensure(ref(1), true), s.ensure(ref(1), false)]);
    expect(calls).toHaveLength(1);
    expect(s.hasBitmap(ref(1))).toBe(true);
    await s.ensure(ref(2), false);
    await s.ensure(ref(2), true);
    expect(calls).toHaveLength(3);
  });
  it('evicts least-recently-used packed frames over the byte budget and bitmaps over the count', async () => {
    const { decode } = fake();
    const s = new FrameStore({ packedBytes: 16, bitmaps: 2 }, decode); // each fake grid is 4 x u16 = 8 B: room for two
    for (let i = 0; i < 4; i++) await s.ensure(ref(i), true);
    expect(s.size.packed).toBe(2);
    expect(s.size.bytes).toBeLessThanOrEqual(16);
    expect(s.hasPacked(ref(0))).toBe(false);
    expect(s.hasPacked(ref(3))).toBe(true);
    expect(s.size.bitmaps).toBe(2);
    expect(s.hasBitmap(ref(3))).toBe(true);
    expect(s.hasBitmap(ref(0))).toBe(false);
  });
  it('a failed decode is not cached and can be retried', async () => {
    let fail = true;
    const s = new FrameStore(undefined, async (url, kind) => {
      if (fail) throw new Error(`${url}: HTTP 404`);
      return { packed: { kind: 'scalar', w: 1, h: 1, data: new Uint16Array(1) } as Packed };
    });
    await expect(s.ensure(ref(0), false)).rejects.toThrow(/HTTP 404/);
    fail = false;
    await s.ensure(ref(0), false);
    expect(s.hasPacked(ref(0))).toBe(true);
  });
});
