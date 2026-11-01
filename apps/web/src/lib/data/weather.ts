/**
 * CONTRACTS section 1b (weather fields v2): models, levels, scalar fields.
 * Strict about what the app relies on, lenient about extras. Errors carry a path so producers can fix bugs fast.
 */
import { ContractError, type WindImageMeta, type WindLatest } from './contracts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (c: string, p: string, v: unknown): Obj => {
  if (!isObj(v)) throw new ContractError(c, p, 'expected an object');
  return v;
};
const arr = (c: string, p: string, v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new ContractError(c, p, 'expected an array');
  return v;
};
const num = (c: string, p: string, v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ContractError(c, p, `expected a finite number, got ${JSON.stringify(v)}`);
  return v;
};
const str = (c: string, p: string, v: unknown): string => {
  if (typeof v !== 'string' || v === '') throw new ContractError(c, p, `expected a non-empty string, got ${JSON.stringify(v)}`);
  return v;
};
const isoZ = (c: string, p: string, v: unknown): string => {
  const s = str(c, p, v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(s) || Number.isNaN(Date.parse(s)))
    throw new ContractError(c, p, `expected UTC ISO-8601 with trailing Z, got "${s}"`);
  return s;
};
const pair = (c: string, p: string, v: unknown): [number, number] => {
  const a = arr(c, p, v);
  if (a.length !== 2) throw new ContractError(c, p, `expected [min, max], got ${a.length} elements`);
  const lo = num(c, `${p}[0]`, a[0]);
  const hi = num(c, `${p}[1]`, a[1]);
  if (!(hi > lo)) throw new ContractError(c, p, `max (${hi}) must be greater than min (${lo})`);
  return [lo, hi];
};

export type ModelId = 'gfs' | 'ecmwf-ifs' | 'ecmwf-aifs' | (string & {});
export interface WeatherGrid {
  width: number;
  height: number;
  lon_left: number;
  lon_right: number;
  lat_top: number;
  lat_bottom: number;
}
export interface WeatherFrame {
  fhr: number;
  valid: string;
  png: string;
  bytes?: number;
}
export interface FieldLevel {
  type: string;
  value: number;
  label: string;
}
export interface VectorRange {
  u: [number, number];
  v: [number, number];
  speed_max: number;
}
interface FieldBase {
  id: string;
  slug: string;
  units: string;
  frames: WeatherFrame[];
}
export interface VectorField extends FieldBase {
  kind: 'vector';
  level: FieldLevel;
  range: VectorRange;
}
export interface ScalarField extends FieldBase {
  kind: 'scalar';
  range: [number, number];
  transform?: 'sqrt';
}
export type WeatherField = VectorField | ScalarField;

export interface WeatherModel {
  schema: 2;
  model: ModelId;
  name: string;
  licence: string;
  run: string;
  generated: string;
  stale?: boolean;
  grid: WeatherGrid;
  fields: WeatherField[];
}
export interface WeatherIndexEntry {
  id: ModelId;
  name: string;
  licence: string;
  run: string;
  latest: string;
}
export interface WeatherIndex {
  schema: 2;
  generated: string;
  models: WeatherIndexEntry[];
}

const C_IDX = 'weather/index.json';

export function parseWeatherIndex(raw: unknown): WeatherIndex {
  const o = obj(C_IDX, '$', raw);
  const schema = num(C_IDX, 'schema', o.schema);
  if (schema !== 2) throw new ContractError(C_IDX, 'schema', `unsupported schema ${schema} (this app understands 2)`);
  const seen = new Set<string>();
  const models = arr(C_IDX, 'models', o.models).map((m, i): WeatherIndexEntry => {
    const p = `models[${i}]`;
    const mo = obj(C_IDX, p, m);
    const id = str(C_IDX, `${p}.id`, mo.id);
    if (seen.has(id)) throw new ContractError(C_IDX, `${p}.id`, `duplicate model id "${id}"`);
    seen.add(id);
    const latest = str(C_IDX, `${p}.latest`, mo.latest);
    if (/^([a-z]+:)?\/\//i.test(latest) || latest.startsWith('/'))
      throw new ContractError(C_IDX, `${p}.latest`, `must be relative to the data root, got "${latest}"`);
    return { id, name: typeof mo.name === 'string' && mo.name ? mo.name : id, licence: typeof mo.licence === 'string' ? mo.licence : '', run: isoZ(C_IDX, `${p}.run`, mo.run), latest };
  });
  if (models.length === 0) throw new ContractError(C_IDX, 'models', 'must list at least one model');
  return { schema: 2, generated: isoZ(C_IDX, 'generated', o.generated), models };
}

export function parseWeatherModel(raw: unknown, expectId?: string): WeatherModel {
  const C = expectId ? `weather/${expectId}/latest.json` : 'weather/<model>/latest.json';
  const o = obj(C, '$', raw);
  const schema = num(C, 'schema', o.schema);
  if (schema !== 2) throw new ContractError(C, 'schema', `unsupported schema ${schema} (this app understands 2)`);
  const model = str(C, 'model', o.model);
  if (expectId && model !== expectId) throw new ContractError(C, 'model', `file says "${model}" but the catalogue listed "${expectId}"`);
  const g = obj(C, 'grid', o.grid);
  const grid: WeatherGrid = {
    width: num(C, 'grid.width', g.width),
    height: num(C, 'grid.height', g.height),
    lon_left: num(C, 'grid.lon_left', g.lon_left),
    lon_right: num(C, 'grid.lon_right', g.lon_right),
    lat_top: num(C, 'grid.lat_top', g.lat_top),
    lat_bottom: num(C, 'grid.lat_bottom', g.lat_bottom)
  };
  if (grid.width < 2 || grid.height < 2) throw new ContractError(C, 'grid', 'width/height must be >= 2');
  if (!(grid.lat_top > grid.lat_bottom)) throw new ContractError(C, 'grid', 'lat_top must be > lat_bottom');
  if (!(grid.lon_right > grid.lon_left)) throw new ContractError(C, 'grid', 'lon_right must be > lon_left');

  const slugs = new Set<string>();
  const fields = arr(C, 'fields', o.fields).map((f, i): WeatherField => {
    const p = `fields[${i}]`;
    const fo = obj(C, p, f);
    const id = str(C, `${p}.id`, fo.id);
    const slug = str(C, `${p}.slug`, fo.slug);
    if (!/^[a-z0-9_]+$/.test(slug)) throw new ContractError(C, `${p}.slug`, `slug must match [a-z0-9_]+, got "${slug}"`);
    if (slugs.has(slug)) throw new ContractError(C, `${p}.slug`, `duplicate slug "${slug}"`);
    slugs.add(slug);
    const kind = fo.kind;
    if (kind !== 'vector' && kind !== 'scalar') throw new ContractError(C, `${p}.kind`, `expected "vector" or "scalar", got ${JSON.stringify(kind)}`);
    const frames = arr(C, `${p}.frames`, fo.frames).map((fr, j): WeatherFrame => {
      const q = `${p}.frames[${j}]`;
      const fro = obj(C, q, fr);
      const png = str(C, `${q}.png`, fro.png);
      if (/^([a-z]+:)?\/\//i.test(png) || png.startsWith('/')) throw new ContractError(C, `${q}.png`, `must be relative to the data root, got "${png}"`);
      return { fhr: num(C, `${q}.fhr`, fro.fhr), valid: isoZ(C, `${q}.valid`, fro.valid), png, bytes: fro.bytes === undefined ? undefined : num(C, `${q}.bytes`, fro.bytes) };
    });
    if (frames.length === 0) throw new ContractError(C, `${p}.frames`, 'must contain at least one frame');
    for (let j = 1; j < frames.length; j++)
      if (frames[j]!.fhr <= frames[j - 1]!.fhr) throw new ContractError(C, `${p}.frames[${j}].fhr`, 'frames must be sorted by increasing fhr');
    const units = str(C, `${p}.units`, fo.units);
    if (kind === 'vector') {
      if (units !== 'm/s') throw new ContractError(C, `${p}.units`, `vector fields must be in "m/s", got "${units}"`);
      const lv = obj(C, `${p}.level`, fo.level);
      const r = obj(C, `${p}.range`, fo.range);
      const speed_max = num(C, `${p}.range.speed_max`, r.speed_max);
      if (!(speed_max > 0)) throw new ContractError(C, `${p}.range.speed_max`, 'must be > 0');
      return {
        kind, id, slug, units, frames,
        level: { type: str(C, `${p}.level.type`, lv.type), value: num(C, `${p}.level.value`, lv.value), label: str(C, `${p}.level.label`, lv.label) },
        range: { u: pair(C, `${p}.range.u`, r.u), v: pair(C, `${p}.range.v`, r.v), speed_max }
      };
    }
    const transform = fo.transform;
    if (transform !== undefined && transform !== 'sqrt') throw new ContractError(C, `${p}.transform`, `unknown transform ${JSON.stringify(transform)} (expected "sqrt")`);
    return { kind, id, slug, units, frames, range: pair(C, `${p}.range`, fo.range), transform: transform as 'sqrt' | undefined };
  });
  if (fields.length === 0) throw new ContractError(C, 'fields', 'must list at least one field');
  return {
    schema: 2,
    model,
    name: typeof o.name === 'string' && o.name ? o.name : model,
    licence: typeof o.licence === 'string' ? o.licence : '',
    run: isoZ(C, 'run', o.run),
    generated: isoZ(C, 'generated', o.generated),
    stale: o.stale === true ? true : undefined,
    grid,
    fields
  };
}

/** Wrap the legacy CONTRACTS section 1 file as a one-field GFS model so the rest of the app has one code path. */
export function modelFromLegacyWind(w: WindLatest): WeatherModel {
  const levelM = /^(\d+)\s*m$/i.exec(w.level);
  const level: FieldLevel = levelM ? { type: 'height_agl', value: Number(levelM[1]), label: `${levelM[1]} m` } : { type: 'height_agl', value: 10, label: '10 m' };
  return {
    schema: 2,
    model: 'gfs',
    name: w.source,
    licence: w.licence,
    run: w.run,
    generated: w.generated,
    grid: { width: w.image.width, height: w.image.height, lon_left: w.image.lon_left, lon_right: w.image.lon_right, lat_top: w.image.lat_top, lat_bottom: w.image.lat_bottom },
    fields: [
      {
        kind: 'vector', id: `wind@${level.value}m`, slug: `wind_${level.value}m`, units: 'm/s', level,
        range: { u: [w.image.u.min, w.image.u.max], v: [w.image.v.min, w.image.v.max], speed_max: w.image.speed_max },
        frames: w.frames
      }
    ]
  };
}

/** The wind-layer's image descriptor for a vector field of a model. */
export function windMetaFor(grid: WeatherGrid, f: VectorField): WindImageMeta {
  return { ...grid, u: { min: f.range.u[0], max: f.range.u[1] }, v: { min: f.range.v[0], max: f.range.v[1] }, speed_max: f.range.speed_max };
}
