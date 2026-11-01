import type { ScalarField, VectorField, WeatherModel } from '#lib/data/weather';
import type { Packed } from './pack';
import { sampleScalar, sampleVector } from './sample';
import { scalarField, windFieldAt } from './select';

export interface WindPoint { t: number; fhr: number; u: number; v: number; speed: number; deg: number }
export interface ValuePoint { t: number; fhr: number; value: number }
export interface PrecipPoint extends ValuePoint { /** hours covered by this bar (interval ending at t) */ hours: number }

export interface Meteogram {
  lon: number;
  lat: number;
  wind: (WindPoint | null)[];
  mslp: (ValuePoint | null)[];
  t2m: (ValuePoint | null)[];
  precip: (PrecipPoint | null)[];
  /** frames still to load per series key; 0 when complete */
  pending: number;
  total: number;
}

export interface SeriesFrameRef { field: VectorField | ScalarField; index: number }
export type SeriesKey = 'wind' | 'mslp' | 't2m' | 'precip';
export const SERIES_KEYS: SeriesKey[] = ['wind', 'mslp', 't2m', 'precip'];

/** Every (field, frame) pair the meteogram needs for a model. Wind uses the 10 m field (or the lowest available). */
export function meteogramFrames(m: WeatherModel, include: readonly SeriesKey[] = SERIES_KEYS): SeriesFrameRef[] {
  const out: SeriesFrameRef[] = [];
  const fields = [
    include.includes('wind') ? windFieldAt(m, '10m') : null,
    include.includes('mslp') ? scalarField(m, 'pressure') : null,
    include.includes('t2m') ? scalarField(m, 'temperature') : null,
    include.includes('precip') ? scalarField(m, 'precipitation') : null
  ];
  for (const f of fields) if (f) f.frames.forEach((_, index) => out.push({ field: f, index }));
  return out;
}

/**
 * Build the series at a point from whatever frames are available through `lookup`.
 * Missing frames yield null entries (so the chart can show a partial series while loading).
 */
export function buildMeteogram(m: WeatherModel, lon: number, lat: number, lookup: (field: VectorField | ScalarField, index: number) => Packed | null, include: readonly SeriesKey[] = SERIES_KEYS): Meteogram {
  const wf = include.includes('wind') ? windFieldAt(m, '10m') : null;
  const pf = include.includes('mslp') ? scalarField(m, 'pressure') : null;
  const tf = include.includes('t2m') ? scalarField(m, 'temperature') : null;
  const rf = include.includes('precip') ? scalarField(m, 'precipitation') : null;
  let pending = 0, total = 0;
  const walk = <T>(f: VectorField | ScalarField | null, make: (p: Packed, i: number, t: number, fhr: number) => T | null): (T | null)[] => {
    if (!f) return [];
    return f.frames.map((fr, i) => {
      total++;
      const p = lookup(f, i);
      if (!p) { pending++; return null; }
      return make(p, i, Date.parse(fr.valid), fr.fhr);
    });
  };
  const wind = walk(wf, (p, _i, t, fhr) => {
    const s = sampleVector(p, m.grid, (wf as VectorField).range, lon, lat);
    return s ? { t, fhr, u: s.u, v: s.v, speed: s.speed, deg: s.deg } : null;
  });
  const value = (f: ScalarField | null) => (p: Packed, _i: number, t: number, fhr: number): ValuePoint | null => {
    const x = f ? sampleScalar(p, m.grid, f.range, f.transform, lon, lat) : null;
    return x === null ? null : { t, fhr, value: x };
  };
  const mslp = walk(pf, value(pf));
  const t2m = walk(tf, value(tf));
  const precip = walk(rf, (p, i, t, fhr) => {
    const x = sampleScalar(p, m.grid, rf!.range, rf!.transform, lon, lat);
    if (x === null) return null;
    const prev = i > 0 ? rf!.frames[i - 1]!.fhr : fhr;
    return { t, fhr, value: Math.max(0, x), hours: Math.max(0, fhr - prev) };
  });
  return { lon, lat, wind, mslp, t2m, precip, pending, total };
}
