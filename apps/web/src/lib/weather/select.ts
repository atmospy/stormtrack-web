import type { ScalarField, VectorField, WeatherField, WeatherModel } from '#lib/data/weather';

export type Variable = 'wind' | 'pressure' | 'temperature' | 'precipitation';
export const VARIABLES: { id: Variable; label: string; field?: string }[] = [
  { id: 'wind', label: 'Wind' },
  { id: 'pressure', label: 'Pressure', field: 'mslp' },
  { id: 'temperature', label: 'Temp', field: 't2m' },
  { id: 'precipitation', label: 'Rain', field: 'precip' }
];

/** Level ids in display order (surface first, then upward). */
export const LEVEL_ORDER = ['10m', '850', '700', '500', '300', '250'] as const;
const HEIGHT: Record<string, string> = { '10m': '10 m above ground', '850': '≈ 1.5 km', '700': '≈ 3 km', '500': '≈ 5.5 km', '300': '≈ 9 km', '250': '≈ 10.5 km' };

/** Level key of a vector field: "10m" for height_agl 10, else the pressure in hPa as a string. */
export function levelKey(f: VectorField): string {
  return f.level.type === 'pressure' ? String(f.level.value) : `${f.level.value}m`;
}
export function levelLabel(key: string): string {
  return key.endsWith('m') ? `${key.slice(0, -1)} m` : `${key} hPa`;
}
/** "850 hPa ≈ 1.5 km" */
export function levelDescription(key: string): string {
  const h = HEIGHT[key];
  return key.endsWith('m') ? `${levelLabel(key)}` : h ? `${levelLabel(key)} ${h}` : levelLabel(key);
}

export function windFields(m: WeatherModel): VectorField[] {
  const out = m.fields.filter((f): f is VectorField => f.kind === 'vector' && f.id.startsWith('wind@'));
  const rank = (f: VectorField) => {
    const i = LEVEL_ORDER.indexOf(levelKey(f) as (typeof LEVEL_ORDER)[number]);
    return i < 0 ? 99 : i;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}
export function levelsOf(m: WeatherModel): string[] {
  return windFields(m).map(levelKey);
}
export function scalarField(m: WeatherModel, v: Variable): ScalarField | null {
  const id = VARIABLES.find((x) => x.id === v)?.field;
  const f = m.fields.find((x) => x.id === id);
  return f && f.kind === 'scalar' ? f : null;
}
export function variablesOf(m: WeatherModel): Variable[] {
  return VARIABLES.filter((v) => (v.id === 'wind' ? windFields(m).length > 0 : scalarField(m, v.id))).map((v) => v.id);
}
/** The wind field for a level, falling back to the nearest available level (surface first). */
export function windFieldAt(m: WeatherModel, level: string): VectorField | null {
  const all = windFields(m);
  return all.find((f) => levelKey(f) === level) ?? all[0] ?? null;
}
/** The field that defines the time axis for the current selection. */
export function primaryField(m: WeatherModel, v: Variable, level: string): WeatherField | null {
  return v === 'wind' ? windFieldAt(m, level) : scalarField(m, v);
}

// ---------- time ----------
export function timeline(f: WeatherField | null): number[] {
  return f ? f.frames.map((fr) => Date.parse(fr.valid)) : [];
}
/** Index of the frame whose valid time is nearest to `ms` (ties go to the earlier frame). */
export function nearestIndex(times: number[], ms: number): number {
  if (times.length === 0) return 0;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < ms) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && ms - times[lo - 1]! <= times[lo]! - ms) lo -= 1;
  return lo;
}
